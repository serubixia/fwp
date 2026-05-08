import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MANAGED_STORAGE_ENTRY_PREFIX = 'ffmpeg-api-';
const storageReservations = new Map();

function getReservationRegistry(storageRoot) {
  const existingRegistry = storageReservations.get(storageRoot);
  if (existingRegistry != null) {
    return existingRegistry;
  }

  const reservationRegistry = new Map();
  storageReservations.set(storageRoot, reservationRegistry);
  return reservationRegistry;
}

function getReservedBytes(storageRoot) {
  return [...getReservationRegistry(storageRoot).values()]
    .reduce((totalBytes, reservedBytes) => totalBytes + reservedBytes, 0);
}

function ensureNonNegativeInteger(value, label, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsedValue;
}

export function resolveManagedStorageRoot(value = process.env.FFMPEG_STORAGE_ROOT ?? process.env.ASYNC_JOB_STORAGE_ROOT) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return tmpdir();
  }

  return path.resolve(value.trim());
}

export function resolveManagedStorageMaxBytes(value = process.env.FFMPEG_STORAGE_MAX_BYTES) {
  return ensureNonNegativeInteger(value, 'FFMPEG_STORAGE_MAX_BYTES', 0);
}

async function ensureManagedStorageRoot(storageRoot = resolveManagedStorageRoot()) {
  await mkdir(storageRoot, { recursive: true });
  return storageRoot;
}

async function getPathSizeBytes(targetPath) {
  const targetStats = await stat(targetPath);
  if (!targetStats.isDirectory()) {
    return targetStats.size;
  }

  const childEntries = await readdir(targetPath, { withFileTypes: true });
  const childSizes = await Promise.all(childEntries.map((childEntry) => getPathSizeBytes(path.join(targetPath, childEntry.name))));
  return childSizes.reduce((totalBytes, childBytes) => totalBytes + childBytes, 0);
}

async function getManagedStorageUsageBytes(storageRoot = resolveManagedStorageRoot()) {
  const childEntries = await readdir(storageRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  });

  const managedEntries = childEntries.filter((childEntry) => childEntry.name.startsWith(MANAGED_STORAGE_ENTRY_PREFIX));
  const managedEntrySizes = await Promise.all(
    managedEntries.map((managedEntry) => getPathSizeBytes(path.join(storageRoot, managedEntry.name)))
  );

  return managedEntrySizes.reduce((totalBytes, managedEntryBytes) => totalBytes + managedEntryBytes, 0);
}

function createStorageQuotaExceededError({
  storageRoot,
  maxBytes,
  usageBytes,
  reservedBytes,
  requestedBytes,
}) {
  const availableBytes = Math.max(0, maxBytes - usageBytes - reservedBytes);
  const error = new Error('Managed storage quota exceeded.');

  error.code = 'STORAGE_QUOTA_EXCEEDED';
  error.statusCode = 503;
  error.details = {
    storage_root: storageRoot,
    max_storage_bytes: maxBytes,
    usage_bytes: usageBytes,
    reserved_bytes: reservedBytes,
    requested_bytes: requestedBytes,
    available_bytes: availableBytes,
  };
  return error;
}

export async function reserveManagedStorageBytes({
  storageRoot = resolveManagedStorageRoot(),
  maxBytes = resolveManagedStorageMaxBytes(),
  bytes = 0,
} = {}) {
  const requestedBytes = ensureNonNegativeInteger(bytes, 'managed storage reservation bytes', 0);
  if (maxBytes === 0) {
    let currentBytes = requestedBytes;
    let currentUsageBytes = 0;

    return {
      storageRoot,
      get bytes() {
        return currentBytes;
      },
      get usageBytes() {
        return currentUsageBytes;
      },
      async setBytes(nextBytes) {
        currentBytes = ensureNonNegativeInteger(nextBytes, 'managed storage reservation bytes', 0);
      },
      release() {},
    };
  }

  await ensureManagedStorageRoot(storageRoot);
  const initialUsageBytes = await getManagedStorageUsageBytes(storageRoot);
  const reservationRegistry = getReservationRegistry(storageRoot);
  const reservationId = randomUUID();
  let released = false;
  let currentBytes = 0;
  let currentUsageBytes = initialUsageBytes;
  reservationRegistry.set(reservationId, currentBytes);

  async function setBytes(nextBytes, { usageBytes } = {}) {
    const targetBytes = ensureNonNegativeInteger(nextBytes, 'managed storage reservation bytes', 0);
    if (released) {
      throw new Error('Managed storage reservation was already released.');
    }

    const effectiveUsageBytes = usageBytes == null
      ? await getManagedStorageUsageBytes(storageRoot)
      : ensureNonNegativeInteger(usageBytes, 'managed storage usage bytes', 0);
    const reservedBytes = Math.max(0, getReservedBytes(storageRoot) - currentBytes);
    if (effectiveUsageBytes + reservedBytes + targetBytes > maxBytes) {
      throw createStorageQuotaExceededError({
        storageRoot,
        maxBytes,
        usageBytes: effectiveUsageBytes,
        reservedBytes,
        requestedBytes: targetBytes,
      });
    }

    currentUsageBytes = effectiveUsageBytes;
    currentBytes = targetBytes;
    reservationRegistry.set(reservationId, currentBytes);
  }

  try {
    await setBytes(requestedBytes, { usageBytes: initialUsageBytes });
  } catch (error) {
    reservationRegistry.delete(reservationId);
    if (reservationRegistry.size === 0) {
      storageReservations.delete(storageRoot);
    }

    throw error;
  }

  return {
    storageRoot,
    get bytes() {
      return currentBytes;
    },
    get usageBytes() {
      return currentUsageBytes;
    },
    setBytes,
    release() {
      if (released) {
        return;
      }

      released = true;
      reservationRegistry.delete(reservationId);
      if (reservationRegistry.size === 0) {
        storageReservations.delete(storageRoot);
      }
    },
  };
}
