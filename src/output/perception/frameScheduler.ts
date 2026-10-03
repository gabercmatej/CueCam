/**
 * Decides which camera frames go to the tracker worker: every `trackEvery`th frame, and
 * never while a frame is still in flight. A busy tracker means frames are skipped, not
 * queued, so results are never older than one tracking run.
 */
export class FrameScheduler {
  /** Frames skipped because the tracker was still busy (a load signal). */
  busySkips = 0
  private sinceSent = Infinity
  /** Timestamp of the frame in flight (also when it was sent). */
  private inFlightSince: number | null = null

  constructor(
    public trackEvery: number,
    /** A frame in flight longer than this is given up on (worker restarted, GPU reset…). */
    private readonly stallMs = 1000
  ) {}

  get busy(): boolean {
    return this.inFlightSince !== null
  }

  /** Call once per camera frame. True = grab this frame and send it. */
  offer(now: number): boolean {
    this.sinceSent++
    if (this.inFlightSince !== null && now - this.inFlightSince < this.stallMs) {
      if (this.sinceSent >= this.trackEvery) this.busySkips++
      return false
    }
    if (this.sinceSent < this.trackEvery) return false
    this.sinceSent = 0
    this.inFlightSince = now
    return true
  }

  /** The tracker answered the frame stamped `at`. A late answer to a frame given up on is ignored. */
  done(at: number): void {
    if (at === this.inFlightSince) this.inFlightSince = null
  }
}
