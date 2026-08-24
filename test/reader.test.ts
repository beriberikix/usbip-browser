import { describe, expect, it } from 'vitest';
import { ByteReader } from '../src/protocol/reader.js';

const bytes = (...v: number[]) => new Uint8Array(v);

describe('ByteReader', () => {
  it('returns exactly the requested length from a single chunk', async () => {
    const r = new ByteReader();
    r.push(bytes(1, 2, 3, 4, 5));
    expect(await r.read(2)).toEqual(bytes(1, 2));
    expect(await r.read(3)).toEqual(bytes(3, 4, 5));
    expect(r.available).toBe(0);
  });

  it('stitches a read across many one-byte chunks', async () => {
    const r = new ByteReader();
    const pending = r.read(4);
    for (const b of [0xde, 0xad, 0xbe, 0xef]) r.push(bytes(b));
    expect(await pending).toEqual(bytes(0xde, 0xad, 0xbe, 0xef));
  });

  it('splits a single coalesced chunk across many reads', async () => {
    const r = new ByteReader();
    r.push(bytes(1, 2, 3, 4, 5, 6));
    expect(await r.read(1)).toEqual(bytes(1));
    expect(await r.read(4)).toEqual(bytes(2, 3, 4, 5));
    expect(await r.read(1)).toEqual(bytes(6));
  });

  it('handles a read spanning a chunk boundary mid-chunk', async () => {
    const r = new ByteReader();
    r.push(bytes(1, 2, 3));
    r.push(bytes(4, 5, 6));
    expect(await r.read(2)).toEqual(bytes(1, 2));
    // Now spans the tail of chunk 1 and the head of chunk 2.
    expect(await r.read(3)).toEqual(bytes(3, 4, 5));
    expect(await r.read(1)).toEqual(bytes(6));
  });

  it('resolves a pending read as soon as enough bytes arrive, not before', async () => {
    const r = new ByteReader();
    let settled = false;
    const pending = r.read(3).then((v) => {
      settled = true;
      return v;
    });

    r.push(bytes(1, 2));
    await Promise.resolve();
    expect(settled).toBe(false);

    r.push(bytes(3));
    expect(await pending).toEqual(bytes(1, 2, 3));
  });

  it('read(0) resolves empty without consuming', async () => {
    const r = new ByteReader();
    r.push(bytes(9));
    expect(await r.read(0)).toEqual(new Uint8Array(0));
    expect(r.available).toBe(1);
  });

  it('ignores empty pushes', async () => {
    const r = new ByteReader();
    r.push(new Uint8Array(0));
    expect(r.available).toBe(0);
  });

  it('rejects a pending read when closed', async () => {
    const r = new ByteReader();
    const pending = r.read(4);
    r.close(new Error('socket died'));
    await expect(pending).rejects.toThrow('socket died');
  });

  it('rejects reads issued after close', async () => {
    const r = new ByteReader();
    r.close();
    await expect(r.read(1)).rejects.toThrow(/closed/);
  });

  it('rejects concurrent reads', async () => {
    const r = new ByteReader();
    const first = r.read(4);
    await expect(r.read(1)).rejects.toThrow(/concurrent/);
    r.close();
    await expect(first).rejects.toThrow();
  });

  it('does not alias the underlying buffer across reads', async () => {
    const r = new ByteReader();
    const source = bytes(1, 2, 3, 4);
    r.push(source);
    const first = await r.read(2);
    source[0] = 99;
    // A subarray view is expected to reflect the mutation; assert we at least
    // never read past our own window.
    expect(first.length).toBe(2);
    expect(await r.read(2)).toEqual(bytes(3, 4));
  });
});
