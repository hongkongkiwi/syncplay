import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container} accessibilityLabel="Error screen" testID="error-boundary">
          <Text style={styles.title} maxFontSizeMultiplier={1.5}>Something went wrong</Text>
          <Text style={styles.message} maxFontSizeMultiplier={1.3}>
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </Text>
          <Pressable
            style={styles.retryButton}
            onPress={this.handleRetry}
            accessibilityLabel="Retry"
            accessibilityRole="button"
            testID="error-retry-button"
          >
            <Text style={styles.retryText} maxFontSizeMultiplier={1.3}>Retry</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const colors = {
  bg: '#061015',
  text: '#edf7fb',
  muted: '#8fa3b8',
  accent: '#7fd2ff',
  ink: '#061015',
  error: '#ff8a80'
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16
  },
  title: {
    color: colors.error,
    fontSize: 22,
    fontWeight: '800'
  },
  message: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center'
  },
  retryButton: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.accent,
    marginTop: 8
  },
  retryText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800'
  }
});
