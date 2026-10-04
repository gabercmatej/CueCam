/** Perception tasks a worker can run on a camera frame. */
export type Task = 'hands' | 'segment' | 'face'
export const TASKS: readonly Task[] = ['hands', 'segment', 'face']

/**
 * Decides which camera frames go to a perception worker, and which tasks run on each: every
 * task has its own stride (`every`, in camera frames; 0 = off), tasks that fall due on the
 * same frame share it, and nothing is sent while a frame is still in flight. A busy worker
 * means frames are skipped, never queued; a task that fell due meanwhile runs on the next
 * free frame. So results are never older than one worker run.
 *
 * Segmentation yields to hand tracking by one frame (when both strides leave room, and it
 * isn't overdue; the very first frame runs everything), so the two heavy tasks interleave instead of stacking on the same frame: the
 * worker's load is spread evenly, and the mask doesn't wait behind the hands.
 */
export class TaskScheduler {
  /** Frames skipped because the worker was still busy while a task was due (a load signal). */
  busySkips = 0
  /** Which tasks run on the frame just accepted by `offer` (reused object). */
  readonly due: Record<Task, boolean> = { hands: false, segment: false, face: false }
  readonly every: Record<Task, number>
  private readonly since: Record<Task, number> = { hands: Infinity, segment: Infinity, face: Infinity }
  /** Timestamp of the frame in flight (also when it was sent). */
  private inFlightSince: number | null = null

  constructor(
    every: Record<Task, number>,
    /** A frame in flight longer than this is given up on (worker restarted, GPU reset…). */
    private readonly stallMs = 1000
  ) {
    this.every = { ...every }
  }

  get busy(): boolean {
    return this.inFlightSince !== null
  }

  /** Call once per camera frame. True = grab this frame and send it with the tasks in `due`. */
  offer(now: number): boolean {
    let anyDue = false
    for (const t of TASKS) {
      this.since[t]++
      this.due[t] = this.every[t] > 0 && this.since[t] >= this.every[t]
    }
    // Interleave only when both have frames to spare (hands on every frame leave no free frame to yield to).
    const seg = this.every.segment
    if (this.due.hands && this.due.segment && this.every.hands >= 2 && seg >= 2 && this.since.segment < 2 * seg) this.due.segment = false
    for (const t of TASKS) anyDue ||= this.due[t]
    if (!anyDue) return false
    if (this.inFlightSince !== null && now - this.inFlightSince < this.stallMs) {
      this.busySkips++
      return false
    }
    for (const t of TASKS) if (this.due[t]) this.since[t] = 0
    this.inFlightSince = now
    return true
  }

  /** The worker answered the frame stamped `at`. A late answer to a frame given up on is ignored. */
  done(at: number): void {
    if (at === this.inFlightSince) this.inFlightSince = null
  }
}
