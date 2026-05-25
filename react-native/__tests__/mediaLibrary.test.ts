import {
  addMediaItems,
  buildDirectoryLabels,
  findMediaByName,
  getFilenameFromPath
} from '../src/syncplay/mediaLibrary';

describe('media library helpers', () => {
  const localMovie = {
    name: 'Movie Night.mkv',
    uri: 'file:///storage/emulated/0/Movies/Movie%20Night.mkv',
    size: 1024,
    duration: null,
    directory: 'Movies'
  };

  it('adds picked media once by URI', () => {
    expect(addMediaItems([localMovie], [localMovie])).toEqual([localMovie]);
  });

  it('normalizes missing names from the URI', () => {
    expect(
      addMediaItems([], [
        {
          name: '',
          uri: 'file:///Users/andy/Videos/episode%2001.mp4',
          size: null,
          duration: null,
          directory: null
        }
      ])
    ).toEqual([
      {
        name: 'episode 01.mp4',
        uri: 'file:///Users/andy/Videos/episode%2001.mp4',
        size: 0,
        duration: null,
        directory: 'Videos'
      }
    ]);
  });

  it('finds a picked file by exact filename or basename', () => {
    expect(findMediaByName([localMovie], 'Movie Night.mkv')).toEqual(localMovie);
    expect(findMediaByName([localMovie], '/downloads/Movie Night.mkv')).toEqual(localMovie);
    expect(findMediaByName([localMovie], null)).toBeNull();
  });

  it('matches filenames case-insensitively', () => {
    expect(findMediaByName([localMovie], 'movie night.MKV')).toEqual(localMovie);
  });

  it('returns directory labels in display order', () => {
    expect(
      buildDirectoryLabels([
        localMovie,
        { ...localMovie, name: 'Other.mkv', uri: 'file:///storage/emulated/0/Movies/Other.mkv' },
        { ...localMovie, name: 'Clip.mp4', uri: 'file:///storage/emulated/0/Clips/Clip.mp4', directory: 'Clips' }
      ])
    ).toEqual(['Movies', 'Clips']);
  });

  it('extracts filenames from encoded paths', () => {
    expect(getFilenameFromPath('content://videos/Season%201/Episode%2002.mp4')).toBe('Episode 02.mp4');
    expect(getFilenameFromPath(undefined)).toBe('');
    expect(getFilenameFromPath('file:///movies/bad%zzname.mkv')).toBe('bad%zzname.mkv');
  });

  it('skips incoming items with empty or duplicate URIs', () => {
    expect(
      addMediaItems([localMovie], [
        { name: 'ignored.mkv', uri: '', size: 1, duration: null, directory: null },
        { ...localMovie, name: 'duplicate.mkv' }
      ])
    ).toEqual([localMovie]);
  });

  it('uses a generic fallback name when the URI has no filename', () => {
    expect(
      addMediaItems([], [
        {
          name: '  ',
          uri: 'video',
          size: null,
          duration: null,
          directory: null
        }
      ])
    ).toEqual([
      {
        name: 'video',
        uri: 'video',
        size: 0,
        duration: null,
        directory: null
      }
    ]);
  });
});
