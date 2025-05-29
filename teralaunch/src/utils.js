/**
 * Formats a given number of bytes into a human-readable size string.
 *
 * @param {number} bytes the number of bytes to format
 * @returns {string} the formatted size string
 */
export function formatSize(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = parseFloat(bytes);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Formats a given number of bytes per second into a human-readable speed string.
 *
 * @param {number} bytesPerSecond the number of bytes per second to format
 * @returns {string} the formatted speed string
 */
export function formatSpeed(bytesPerSecond) {
  if (!isFinite(bytesPerSecond) || bytesPerSecond < 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let speed = bytesPerSecond;
  let unitIndex = 0;
  while (speed >= 1024 && unitIndex < units.length - 1) {
    speed /= 1024;
    unitIndex++;
  }
  return `${speed.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Calculates the estimated time remaining for a download based on the total number of bytes downloaded so far, the total size of the download, and the current download speed.
 *
 * @param {number} totalDownloadedBytes the total number of bytes already downloaded
 * @param {number} totalSize the total size of the download in bytes
 * @param {number} speed the current download speed in bytes per second
 * @param {Array<number>} speedHistory - The history of download speeds.
 * @param {number} speedHistoryMaxLength - The maximum length of the speed history.
 * @returns {number} the estimated time remaining in seconds, or 0 if the input is invalid. The result is capped at 30 days maximum.
 */
export function calculateGlobalTimeRemaining(totalDownloadedBytes, totalSize, speed, speedHistory, speedHistoryMaxLength) {
  console.log("Calculating global time remaining:", {
    totalDownloadedBytes,
    totalSize,
    speed,
  });
  if (
    !isFinite(speed) ||
    speed <= 0 ||
    !isFinite(totalDownloadedBytes) ||
    !isFinite(totalSize) ||
    totalDownloadedBytes >= totalSize
  ) {
    console.log("Invalid input for global time remaining calculation");
    return 0;
  }
  let bytesRemaining = totalSize - totalDownloadedBytes;

  let averageSpeed = calculateAverageSpeed(speed, speedHistory, speedHistoryMaxLength);

  let secondsRemaining = bytesRemaining / averageSpeed;
  console.log("Calculated time remaining:", secondsRemaining);
  return Math.min(secondsRemaining, 30 * 24 * 60 * 60); // Limit to 30 days maximum
}

/**
 * Calculates the average speed based on the current speed and speed history.
 * @param {number} currentSpeed - The current download speed.
 * @param {Array<number>} speedHistory - The history of download speeds.
 * @param {number} speedHistoryMaxLength - The maximum length of the speed history.
 * @returns {number} The average speed.
 */
export function calculateAverageSpeed(currentSpeed, speedHistory, speedHistoryMaxLength) {
  // Add current speed to history
  speedHistory.push(currentSpeed);

  // Limit history size
  if (speedHistory.length > speedHistoryMaxLength) {
    speedHistory.shift(); // Remove oldest value
  }

  // Calculate average speed
  const sum = speedHistory.reduce((acc, speedVal) => acc + speedVal, 0);
  const averageSpeed = sum / speedHistory.length;

  console.log("Speed history:", speedHistory);
  console.log("Average speed:", averageSpeed);

  return averageSpeed;
}

/**
 * Format a time in seconds to a human-readable string.
 * If the input is invalid, returns 'Calculating...'
 * @param {number} seconds the time in seconds
 * @returns {string} a human-readable string representation of the time
 */
export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "Calculating...";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${remainingSeconds}s`;
  }
}

/**
 * Returns the file name from a given path, or an empty string if the path is invalid.
 * @param {string} path the path to get the file name from
 * @returns {string} the file name
 */
export function getFileName(path) {
  return path ? path.split("\\").pop().split("/").pop() : "";
}
