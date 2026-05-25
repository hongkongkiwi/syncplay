import { calculateSyncCorrection } from '../src/app/syncControl';

describe('sync correction', () => {
  it('hard seeks on explicit seek requests', () => {
    expect(
      calculateSyncCorrection({
        hasMedia: true,
        syncPaused: false,
        localPosition: 10,
        remotePosition: 20,
        remotePaused: false,
        localPlaying: true,
        doSeek: true
      })
    ).toMatchObject({
      seekTo: 20,
      rate: 1
    });
  });

  it('uses small playback-rate corrections for mild drift while playing', () => {
    expect(
      calculateSyncCorrection({
        hasMedia: true,
        syncPaused: false,
        localPosition: 9.2,
        remotePosition: 10,
        remotePaused: false,
        localPlaying: true,
        doSeek: false
      })
    ).toMatchObject({ rate: 1.04 });

    expect(
      calculateSyncCorrection({
        hasMedia: true,
        syncPaused: false,
        localPosition: 10.8,
        remotePosition: 10,
        remotePaused: false,
        localPlaying: true,
        doSeek: false
      })
    ).toMatchObject({ rate: 0.96 });
  });

  it('pauses, plays, or does nothing based on remote state', () => {
    expect(
      calculateSyncCorrection({
        hasMedia: true,
        syncPaused: false,
        localPosition: 10,
        remotePosition: 10,
        remotePaused: true,
        localPlaying: true,
        doSeek: false
      })
    ).toMatchObject({ shouldPause: true });

    expect(
      calculateSyncCorrection({
        hasMedia: true,
        syncPaused: false,
        localPosition: 10,
        remotePosition: 10,
        remotePaused: false,
        localPlaying: false,
        doSeek: false
      })
    ).toMatchObject({ shouldPlay: true });

    expect(
      calculateSyncCorrection({
        hasMedia: false,
        syncPaused: false,
        localPosition: 0,
        remotePosition: 10,
        remotePaused: false,
        localPlaying: false,
        doSeek: false
      })
    ).toEqual({ rate: 1 });
  });
});
