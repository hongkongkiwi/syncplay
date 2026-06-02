import { VoiceChat } from '../src/syncplay/voiceChat';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Create mock objects that will be referenced inside jest.mock factory
// They must use "mock" prefix so Jest allows hoisting

const mockRecording = {
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
  startAsync: jest.fn().mockResolvedValue(undefined),
  stopAndUnloadAsync: jest.fn().mockResolvedValue(undefined),
  getURI: jest.fn().mockReturnValue('file:///mock/recording.aac'),
  getStatusAsync: jest.fn().mockResolvedValue({ durationMillis: 2500 }),
};

const mockSound = {
  playAsync: jest.fn().mockResolvedValue(undefined),
  unloadAsync: jest.fn().mockResolvedValue(undefined),
  setOnPlaybackStatusUpdate: jest.fn(),
};

jest.mock('expo-av', () => ({
  Audio: {
    Recording: jest.fn().mockImplementation(() => mockRecording),
    Sound: {
      createAsync: jest.fn().mockImplementation(() => Promise.resolve({ sound: mockSound })),
    },
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    RecordingOptionsPresets: {
      HIGH_QUALITY: { android: {}, ios: {} },
    },
  },
}));

jest.mock('expo-file-system', () => {
  const mockFile = {
    uri: 'file:///mock/syncplay_voice_play_0.audio',
    create: jest.fn(),
    write: jest.fn(),
    delete: jest.fn(),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  };
  return {
    File: jest.fn().mockImplementation(() => mockFile),
    Paths: {
      cache: '/mock/cache',
    },
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockStateManager() {
  return {
    onVoiceFrame: null as ((data: Uint8Array, from: string) => void) | null,
    sendVoiceFrame: jest.fn(),
    sendVoiceMute: jest.fn(),
  };
}

function createVoiceChat(stateManager = createMockStateManager()): VoiceChat {
  return new VoiceChat(stateManager as any);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('VoiceChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates with a P2PStateManager reference', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);
      expect(vc).toBeDefined();
    });

    it('hooks into onVoiceFrame handler', () => {
      const sm = createMockStateManager();
      expect(sm.onVoiceFrame).toBeNull();

      const _vc = createVoiceChat(sm);
      expect(sm.onVoiceFrame).not.toBeNull();
      expect(typeof sm.onVoiceFrame).toBe('function');
    });

    it('defaults to not muted', () => {
      const vc = createVoiceChat();
      expect(vc.isMuted).toBe(false);
    });
  });

  describe('toggleMute()', () => {
    it('toggles mute state from false to true', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      expect(vc.isMuted).toBe(false);
      const result = vc.toggleMute();
      expect(vc.isMuted).toBe(true);
      expect(result).toBe(true);
    });

    it('toggles mute state from true to false', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);
      vc.toggleMute(); // mute
      expect(vc.isMuted).toBe(true);

      const result = vc.toggleMute(); // unmute
      expect(vc.isMuted).toBe(false);
      expect(result).toBe(false);
    });

    it('calls sendVoiceMute on the state manager with correct value', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      vc.toggleMute();
      expect(sm.sendVoiceMute).toHaveBeenCalledWith(true);

      vc.toggleMute();
      expect(sm.sendVoiceMute).toHaveBeenCalledWith(false);
    });
  });

  describe('requestPermission()', () => {
    it('returns true when permission is granted', async () => {
      const vc = createVoiceChat();
      const result = await vc.requestPermission();
      expect(result).toBe(true);
    });

    it('returns false when permission is denied', async () => {
      const { Audio } = require('expo-av');
      Audio.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });

      const vc = createVoiceChat();
      const result = await vc.requestPermission();
      expect(result).toBe(false);
    });

    it('catches errors and returns false', async () => {
      const { Audio } = require('expo-av');
      Audio.requestPermissionsAsync.mockRejectedValueOnce(new Error('permission error'));

      const vc = createVoiceChat();
      const result = await vc.requestPermission();
      expect(result).toBe(false);
    });
  });

  describe('startCapture() / stopCapture()', () => {
    it('requests permission if not already granted', async () => {
      const { Audio } = require('expo-av');
      const vc = createVoiceChat();

      await vc.startCapture();
      expect(Audio.requestPermissionsAsync).toHaveBeenCalled();
      await vc.stopCapture();
    });

    it('does not start if permission is denied', async () => {
      const { Audio } = require('expo-av');
      Audio.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });

      const vc = createVoiceChat();
      await vc.startCapture();
      expect(Audio.setAudioModeAsync).not.toHaveBeenCalled();
    });

    it('stopCapture is a no-op when not capturing', async () => {
      const vc = createVoiceChat();
      await vc.stopCapture();
    });
  });

  describe('handleIncomingFrame()', () => {
    it('processes incoming voice data', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      const testData = new Uint8Array([65, 66, 67]); // "ABC"

      expect(() => {
        vc.handleIncomingFrame(testData, 'peer123');
      }).not.toThrow();
    });

    it('accepts empty data', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      const emptyData = new Uint8Array(0);
      expect(() => {
        vc.handleIncomingFrame(emptyData, 'peer123');
      }).not.toThrow();
    });

    it('includes the sender peer ID', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      const testData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      expect(() => {
        vc.handleIncomingFrame(testData, 'specific-peer-id');
      }).not.toThrow();
    });
  });

  describe('destroy()', () => {
    it('clears onVoiceFrame handler', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      expect(sm.onVoiceFrame).not.toBeNull();
      vc.destroy();
      expect(sm.onVoiceFrame).toBeNull();
    });

    it('handles double destroy gracefully', () => {
      const sm = createMockStateManager();
      const vc = createVoiceChat(sm);

      vc.destroy();
      expect(() => vc.destroy()).not.toThrow();
    });
  });

  describe('playAudioUrl()', () => {
    it('creates a Sound and plays it', async () => {
      const vc = createVoiceChat();
      await vc.playAudioUrl('file:///test/audio.aac', 'test-peer');

      const { Audio } = require('expo-av');
      expect(Audio.Sound.createAsync).toHaveBeenCalledWith(
        { uri: 'file:///test/audio.aac' },
        { shouldPlay: false, volume: 1.0 },
      );
      expect(mockSound.playAsync).toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      const { Audio } = require('expo-av');
      Audio.Sound.createAsync.mockRejectedValueOnce(new Error('playback error'));

      const vc = createVoiceChat();
      await expect(vc.playAudioUrl('file:///bad/audio.aac', 'test-peer')).resolves.toBeUndefined();
    });
  });
});
