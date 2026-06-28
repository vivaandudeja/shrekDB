import type { Sample } from './types.js';

/**
 * Largest-Triangle-Three-Buckets downsampling.
 *
 * Reduces a series to `threshold` points while preserving its visual shape —
 * peaks and troughs are retained because the algorithm keeps, from each bucket,
 * the point that forms the largest triangle with the previously-selected point
 * and the average of the next bucket.
 *
 * Reference: Sveinn Steinarsson, "Downsampling Time Series for Visual
 * Representation" (2013).
 *
 * @param data      Samples ordered by ascending timestamp.
 * @param threshold Target point count. Non-integers are floored; values ≥ length
 *                  or ≤ 2 return a copy.
 */
export function lttb(data: Sample[], threshold: number): Sample[] {
  const n = data.length;
  // The bucket math assumes an integer target; a fractional threshold would
  // otherwise overshoot the array bounds on the final bucket.
  const target = Math.floor(threshold);
  if (target <= 0) return [];
  if (target >= n) return data.slice(); // can't synthesize more points than we have
  if (target === 1) return [data[0]];
  if (target === 2) return [data[0], data[n - 1]]; // honor "at most N" — keep the endpoints

  const sampled: Sample[] = [];
  // Buckets span the interior points; the first and last are always kept.
  const bucketSize = (n - 2) / (target - 2);

  let selectedIdx = 0;
  sampled.push(data[0]); // first point is always included

  for (let i = 0; i < target - 2; i++) {
    // Average point of the *next* bucket — the third triangle vertex.
    let avgX = 0;
    let avgY = 0;
    let avgStart = Math.floor((i + 1) * bucketSize) + 1;
    let avgEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    const avgCount = avgEnd - avgStart;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += data[j].timestamp;
      avgY += data[j].value;
    }
    avgX /= avgCount;
    avgY /= avgCount;

    // Range of the *current* bucket to choose a representative point from.
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, n);

    const anchorX = data[selectedIdx].timestamp;
    const anchorY = data[selectedIdx].value;

    let maxArea = -1;
    let nextIdx = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      // Triangle area (×2) spanned by anchor, candidate, and next-bucket average.
      const area = Math.abs(
        (anchorX - avgX) * (data[j].value - anchorY) -
          (anchorX - data[j].timestamp) * (avgY - anchorY),
      );
      if (area > maxArea) {
        maxArea = area;
        nextIdx = j;
      }
    }

    sampled.push(data[nextIdx]);
    selectedIdx = nextIdx;
  }

  sampled.push(data[n - 1]); // last point is always included
  return sampled;
}
