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

export async function ensureManagedStorageRoot(storageRoot = resolveManagedStorageRoot()) {
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

export async function getManagedStorageUsageBytes(storageRoot = resolveManagedStorageRoot()) {
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

export function createStorageQuotaExceededError({
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

export function isStorageQuotaExceededError(error) {
  return error?.code === 'STORAGE_QUOTA_EXCEEDED';
}

export async function reserveManagedStorageBytes({
  storageRoot = resolveManagedStorageRoot(),
  maxBytes = resolveManagedStorageMaxBytes(),
  bytes = 0,
} = {}) {
  const requestedBytes = ensureNonNegativeInteger(bytes, 'managed storage reservation bytes', 0);
  if (maxBytes === 0 || requestedBytes === 0) {
    return {
      storageRoot,
      bytes: requestedBytes,
      release() {},
    };
  }

  await ensureManagedStorageRoot(storageRoot);
  const usageBytes = await getManagedStorageUsageBytes(storageRoot);
  const reservedBytes = getReservedBytes(storageRoot);
  if (usageBytes + reservedBytes + requestedBytes > maxBytes) {
    throw createStorageQuotaExceededError({
      storageRoot,
      maxBytes,
      usageBytes,
      reservedBytes,
      requestedBytes,
    });
  }

  const reservationRegistry = getReservationRegistry(storageRoot);
  const reservationId = randomUUID();
  let released = false;
  reservationRegistry.set(reservationId, requestedBytes);

  return {
    storageRoot,
    bytes: requestedBytes,
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