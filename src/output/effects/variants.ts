/**
 * Picks one of an effect's files at random, never the one it picked last time (unless it is the
 * only one). `rand` returns 0–1 (injected for tests).
 */
export function pickVariant<T>(files: readonly T[], last: T | undefined, rand: () => number): T | undefined {
  if (files.length <= 1) return files[0]
  const lastIndex = last === undefined ? -1 : files.indexOf(last)
  if (lastIndex < 0) return files[Math.floor(rand() * files.length) % files.length]
  // Pick among the others: shift past the last one.
  const i = Math.floor(rand() * (files.length - 1)) % (files.length - 1)
  return files[i >= lastIndex ? i + 1 : i]
}
