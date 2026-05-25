import { resolvePlaylistItem } from '../src/app/playlistPlayback';

const movie = {
  name: 'movie.mkv',
  uri: 'file:///media/movie.mkv',
  size: 123,
  duration: null,
  directory: 'media'
};

describe('playlist playback helpers', () => {
  it('resolves stream playlist items', () => {
    expect(resolvePlaylistItem(['https://example.test/movie.mp4'], 0, [movie])).toEqual({
      kind: 'stream',
      uri: 'https://example.test/movie.mp4'
    });
  });

  it('resolves local playlist items from media search', () => {
    expect(resolvePlaylistItem(['movie.mkv'], 0, [movie])).toEqual({
      kind: 'local',
      item: movie
    });
  });

  it('reports missing files without crashing', () => {
    expect(resolvePlaylistItem(['missing.mkv'], 0, [movie])).toEqual({
      kind: 'missing',
      filename: 'missing.mkv'
    });
  });

  it('ignores invalid playlist indexes', () => {
    expect(resolvePlaylistItem(['movie.mkv'], null, [movie])).toEqual({ kind: 'none' });
    expect(resolvePlaylistItem(['movie.mkv'], 3, [movie])).toEqual({ kind: 'none' });
  });
});
