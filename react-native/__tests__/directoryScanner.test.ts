import { scanMediaDirectory } from '../src/app/directoryScanner';

type TestDirectory = {
  uri: string;
  name: string;
  list: () => TestEntry[];
};
type TestEntry = ReturnType<typeof file> | TestDirectory;

function file(uri: string, name: string, size = 10) {
  return { uri, name, size };
}

function directory(uri: string, name: string, entries: TestEntry[]): TestDirectory {
  return {
    uri,
    name,
    list: () => entries
  };
}

describe('directory media scanner', () => {
  it('recursively collects video files from picked folders', () => {
    const root = directory('file:///Movies', 'Movies', [
      file('file:///Movies/movie.mkv', 'movie.mkv', 100),
      file('file:///Movies/readme.txt', 'readme.txt', 1),
      directory('file:///Movies/Season', 'Season', [file('file:///Movies/Season/episode.mp4', 'episode.mp4', 200)])
    ]);

    expect(scanMediaDirectory(root)).toEqual([
      {
        name: 'movie.mkv',
        uri: 'file:///Movies/movie.mkv',
        size: 100,
        duration: null,
        directory: 'Movies'
      },
      {
        name: 'episode.mp4',
        uri: 'file:///Movies/Season/episode.mp4',
        size: 200,
        duration: null,
        directory: 'Season'
      }
    ]);
  });

  it('honors depth and file limits', () => {
    const root = directory('file:///Movies', 'Movies', [
      directory('file:///Movies/Season', 'Season', [file('file:///Movies/Season/episode.mp4', 'episode.mp4')]),
      file('file:///Movies/movie.mkv', 'movie.mkv')
    ]);

    expect(scanMediaDirectory(root, { maxDepth: 0, maxFiles: 1 })).toEqual([
      {
        name: 'movie.mkv',
        uri: 'file:///Movies/movie.mkv',
        size: 10,
        duration: null,
        directory: 'Movies'
      }
    ]);
  });
});
