import { describe, expect, it } from 'vitest'
import { ClapFusion } from './clapFusion'

const p = { x: 640, y: 360 }

describe('ClapFusion', () => {
  it('a visual contact alone never fires', () => {
    const f = new ClapFusion()
    expect(f.visual(1000, p, 1030)).toBeNull()
    f.expire(2000)
    expect(f.stats).toEqual({ fused: 0, contactOnly: 1, soundOnly: 0 })
  })

  it('a sound alone never fires', () => {
    const f = new ClapFusion()
    expect(f.sound(1000, 1040)).toBeNull()
    f.expire(2000)
    expect(f.stats).toEqual({ fused: 0, contactOnly: 0, soundOnly: 1 })
  })

  it('fires when the sound came first and the contact follows within the window', () => {
    const f = new ClapFusion()
    expect(f.sound(1000, 1030)).toBeNull()
    expect(f.visual(1020, p, 1050)).toEqual({ at: 1020, position: p, offsetMs: -20 })
    expect(f.stats.fused).toBe(1)
  })

  it('fires when the contact came first and its sound arrives later', () => {
    const f = new ClapFusion()
    expect(f.visual(1000, p, 1020)).toBeNull()
    expect(f.sound(1090, 1160)).toEqual({ at: 1000, position: p, offsetMs: 90 })
  })

  it('does not pair a contact and a sound further apart than the window', () => {
    const f = new ClapFusion()
    f.sound(1000, 1030)
    expect(f.visual(1200, p, 1230)).toBeNull()
    const g = new ClapFusion()
    g.visual(1000, p, 1020)
    expect(g.sound(1151, 1200)).toBeNull()
  })

  it('a sound is used for one clap only', () => {
    const f = new ClapFusion()
    f.sound(1000, 1030)
    expect(f.visual(1010, p, 1040)).not.toBeNull()
    expect(f.visual(1050, p, 1080)).toBeNull()
  })

  it('an old sound expires and cannot pair with a later contact', () => {
    const f = new ClapFusion()
    f.sound(1000, 1030)
    f.expire(1500)
    expect(f.visual(1100, p, 1600)).toBeNull()
  })

  it('requireSound false: the contact fires alone (no-mic fallback)', () => {
    const f = new ClapFusion()
    f.settings = { windowMs: 150, requireSound: false }
    expect(f.visual(1000, p, 1020)).toEqual({ at: 1000, position: p, offsetMs: 0 })
  })
})
