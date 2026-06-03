import { Download, X } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { P2PStateManager } from 'syncplay-p2p-client';

// ── Transfer item type (mirrors the one used in App.tsx) ─────────────────
export interface TransferItem {
  transferId: string;
  filename: string;
  progress: number;
  sentBytes: number;
  totalSize: number;
}

// ── Props ───────────────────────────────────────────────────────────────
export interface TransfersScreenProps {
  /** Active transfers to display */
  transfers: TransferItem[];
  /** Connected state manager (for cancel) */
  stateManager: P2PStateManager | null;
  /** Callback to remove a transfer from the parent list */
  onCancelTransfer?: (transferId: string) => void;
  /** Optional dark mode override */
  darkMode?: boolean;
  /** Optional loading state when transfers are being fetched */
  loading?: boolean;
}

// ── Color palettes ────────────────────────────────────────────────────

const darkPalette = {
  bg: '#061015',
  panel: '#101d25',
  panelSoft: '#142630',
  line: '#263a47',
  text: '#edf7fb',
  muted: '#8fa3b8',
  faint: '#64788b',
  accent: '#7fd2ff',
  green: '#9be28d',
  error: '#ff8a80',
};

const lightPalette = {
  bg: '#f0f2f5',
  panel: '#ffffff',
  panelSoft: '#e8ecf0',
  line: '#d0d5dd',
  text: '#1a1a2e',
  muted: '#5a6070',
  faint: '#8890a0',
  accent: '#2563eb',
  green: '#16a34a',
  error: '#dc2626',
};

// ── Formatting ──────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Styles factory ──────────────────────────────────────────────────────

function createStyles(p: typeof darkPalette) {
  return StyleSheet.create({
    container: {
      gap: 10,
    },
    empty: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 48,
      gap: 12,
    },
    emptyTitle: {
      color: p.text,
      fontSize: 17,
      fontWeight: '700',
    },
    emptySubtitle: {
      color: p.muted,
      fontSize: 13,
      textAlign: 'center',
      lineHeight: 19,
    },
    errorContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 32,
      gap: 12,
    },
    errorText: {
      color: p.error,
      fontSize: 14,
      textAlign: 'center',
    },
    retryButton: {
      minHeight: 36,
      borderRadius: 8,
      paddingHorizontal: 18,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: p.accent,
    },
    retryButtonText: {
      color: p.bg,
      fontSize: 14,
      fontWeight: '800',
    },
    loadingContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 48,
      gap: 12,
    },
    loadingText: {
      color: p.muted,
      fontSize: 13,
    },
    transferCard: {
      backgroundColor: p.panel,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: p.line,
      gap: 10,
    },
    transferInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    transferMeta: {
      flex: 1,
      gap: 2,
    },
    transferName: {
      color: p.text,
      fontSize: 14,
      fontWeight: '600',
    },
    transferSize: {
      color: p.muted,
      fontSize: 12,
    },
    progressTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: p.panelSoft,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: p.accent,
    },
    progressFillDone: {
      backgroundColor: p.green,
    },
    transferFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    transferPct: {
      color: p.muted,
      fontSize: 13,
      fontWeight: '600',
    },
    cancelButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: p.error,
    },
    cancelText: {
      color: p.error,
      fontSize: 12,
      fontWeight: '600',
    },
  });
}

// ── Component ───────────────────────────────────────────────────────────

export default function TransfersScreen({
  transfers,
  stateManager,
  onCancelTransfer,
  darkMode,
  loading = false,
}: TransfersScreenProps) {
  const systemScheme = useColorScheme();
  const isDark = darkMode !== undefined ? darkMode : systemScheme !== 'light';
  const palette = isDark ? darkPalette : lightPalette;
  const styles = createStyles(palette);

  // ── Loading state ───────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={palette.accent} />
        <Text style={styles.loadingText} maxFontSizeMultiplier={1.3}>
          Loading transfers...
        </Text>
      </View>
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────

  if (transfers.length === 0) {
    return (
      <View
        style={styles.empty}
        accessibilityLabel="No active transfers"
        testID="transfers-empty"
      >
        <Download color={palette.muted} size={40} />
        <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.4}>No Active Transfers</Text>
        <Text style={styles.emptySubtitle} maxFontSizeMultiplier={1.3}>
          File transfers will appear here when peers share media.
        </Text>
      </View>
    );
  }

  // ── Transfer list ───────────────────────────────────────────────────

  return (
    <View style={styles.container} testID="transfers-list">
      {transfers.map(t => {
        const pct = Math.round(t.progress * 100);
        const done = t.progress >= 1;

        return (
          <View
            key={t.transferId}
            style={[styles.transferCard, { borderColor: done ? palette.green : palette.line }]}
            accessibilityLabel={`Transfer ${t.filename}, ${pct}% complete`}
            testID={`transfer-${t.transferId}`}
          >
            <View style={styles.transferInfo}>
              <Download
                color={done ? palette.green : palette.accent}
                size={18}
              />
              <View style={styles.transferMeta}>
                <Text
                  style={styles.transferName}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.3}
                >
                  {t.filename}
                </Text>
                <Text style={styles.transferSize} maxFontSizeMultiplier={1.2}>
                  {formatBytes(t.sentBytes)} / {formatBytes(t.totalSize)}
                  {done ? ' · Complete' : ''}
                </Text>
              </View>
            </View>

            {/* Progress bar */}
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${pct}%` as any },
                  done && styles.progressFillDone,
                ]}
              />
            </View>

            {/* Footer: percentage + cancel */}
            <View style={styles.transferFooter}>
              <Text style={styles.transferPct} maxFontSizeMultiplier={1.2}>
                {pct}%
              </Text>
              {!done && stateManager && (
                <Pressable
                  style={styles.cancelButton}
                  onPress={() => {
                    stateManager.cancelTransfer(t.transferId);
                    onCancelTransfer?.(t.transferId);
                  }}
                  accessibilityLabel={`Cancel transfer of ${t.filename}`}
                  accessibilityRole="button"
                  testID={`cancel-transfer-${t.transferId}`}
                >
                  <X color={palette.error} size={16} />
                  <Text style={styles.cancelText} maxFontSizeMultiplier={1.2}>Cancel</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
