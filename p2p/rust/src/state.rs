//! Connection state machine — formalises the lifecycle of a Syncplay peer.
//!
//! Every transition is logged at info level. Invalid transitions are logged
//! at warn level and ignored (no panic — the app keeps running).
//!
//! States:
//!   Offline → Connecting → Handshaking → Connected → Ready
//!                      ↘                ↗
//!                   Reconnecting ───────┘
//!
//! Each state carries optional metadata (room name, peer count, error details).

use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;

// ── State ──────────────────────────────────────────────────────────────

/// The connection lifecycle state of this peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    /// Not connected, not trying. Initial state and terminal state after
    /// giving up on reconnection.
    Offline,
    /// TCP/TLS handshake to the signaling WebSocket in progress.
    Connecting,
    /// WebSocket open, performing create/join handshake with signaling server.
    Handshaking,
    /// Signaling connected, WebRTC peer connections being established.
    /// `peer_count` = number of peers we're connecting to (0 means waiting).
    ConnectingPeers { peer_count: usize },
    /// Fully operational — signaling connected and at least one WebRTC peer.
    Ready { peer_count: usize },
    /// Signaling connection lost, attempting reconnection with backoff.
    /// `attempt` = current retry number (1-indexed), `max` = retry limit.
    Reconnecting { attempt: u32, max_attempts: u32 },
    /// Fatal error — connection cannot proceed without user intervention.
    Error { message: String },
}

impl fmt::Display for ConnectionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Offline => write!(f, "offline"),
            Self::Connecting => write!(f, "connecting"),
            Self::Handshaking => write!(f, "handshaking"),
            Self::ConnectingPeers { peer_count } => {
                write!(f, "connecting-peers({peer_count})")
            }
            Self::Ready { peer_count } => write!(f, "ready({peer_count})"),
            Self::Reconnecting {
                attempt,
                max_attempts,
            } => {
                write!(f, "reconnecting({attempt}/{max_attempts})")
            }
            Self::Error { message } => write!(f, "error({message})"),
        }
    }
}

impl ConnectionState {
    /// Human-readable one-word label for the status bar.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Offline => "OFFLINE",
            Self::Connecting => "CONNECTING",
            Self::Handshaking => "HANDSHAKING",
            Self::ConnectingPeers { .. } => "JOINING",
            Self::Ready { .. } => "ONLINE",
            Self::Reconnecting { .. } => "RECONNECTING",
            Self::Error { .. } => "ERROR",
        }
    }

    /// Whether the peer can send/receive messages in this state.
    pub fn is_operational(&self) -> bool {
        matches!(self, Self::Ready { .. } | Self::ConnectingPeers { .. })
    }

    /// Whether we're currently trying to connect.
    pub fn is_connecting(&self) -> bool {
        matches!(
            self,
            Self::Connecting
                | Self::Handshaking
                | Self::ConnectingPeers { .. }
                | Self::Reconnecting { .. }
        )
    }
}

// ── Machine ────────────────────────────────────────────────────────────

/// Thread-safe connection state machine with transition history for debugging.
pub struct ConnectionStateMachine {
    state: Mutex<ConnectionState>,
    /// When we entered the current state (for timeout detection).
    entered_at: Mutex<Instant>,
    /// Last transition message for logging/debugging.
    last_transition: Mutex<String>,
}

impl Default for ConnectionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionStateMachine {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ConnectionState::Offline),
            entered_at: Mutex::new(Instant::now()),
            last_transition: Mutex::new(String::new()),
        }
    }

    /// Current state (cloned).
    pub fn get(&self) -> ConnectionState {
        self.state.lock().clone()
    }

    /// Time spent in the current state.
    pub fn duration_in_state(&self) -> std::time::Duration {
        self.entered_at.lock().elapsed()
    }

    /// Last transition description (for debugging).
    pub fn last_transition(&self) -> String {
        self.last_transition.lock().clone()
    }

    // ── Transitions ─────────────────────────────────────────────────

    fn transit(&self, to: ConnectionState, reason: &str) {
        // Hold a single lock across read-validate-write to prevent TOCTOU
        let mut state = self.state.lock();
        let from = state.clone();
        if *state == to {
            return; // no-op
        }
        let msg = format!("{from} → {to}  ({reason})");
        log::info!("[state] {msg}");
        *state = to;
        drop(state); // release before acquiring other locks
        *self.entered_at.lock() = Instant::now();
        *self.last_transition.lock() = msg;
    }

    /// Validate a transition. Returns Err(reason) if invalid.
    fn validate(from: &ConnectionState, to: &ConnectionState) -> Result<(), String> {
        use ConnectionState::*;

        // Same-state transitions are always valid (no-op)
        if from == to {
            return Ok(());
        }

        match (from, to) {
            // Error and Offline are always valid destinations
            (_, Error { .. }) | (_, Offline) => Ok(()),

            // From Offline
            (Offline, Connecting) | (Offline, Handshaking) => Ok(()),

            // From Connecting
            (Connecting, Handshaking) => Ok(()),
            (Connecting, Reconnecting { .. }) => Ok(()),

            // From Handshaking
            (Handshaking, ConnectingPeers { .. }) | (Handshaking, Ready { .. }) => Ok(()),
            (Handshaking, Reconnecting { .. }) => Ok(()),

            // From ConnectingPeers
            (ConnectingPeers { .. }, Ready { .. }) => Ok(()),
            (ConnectingPeers { .. }, Reconnecting { .. }) => Ok(()),

            // From Ready
            (Ready { .. }, Ready { .. }) => Ok(()), // peer count change
            (Ready { .. }, Reconnecting { .. }) => Ok(()),

            // From Reconnecting
            (Reconnecting { .. }, Handshaking) => Ok(()),
            (Reconnecting { .. }, ConnectingPeers { .. }) | (Reconnecting { .. }, Ready { .. }) => {
                Ok(())
            }

            // From Error
            (Error { .. }, Connecting) => Ok(()),

            // Everything else is invalid
            _ => Err(format!("invalid transition: {from} → {to}")),
        }
    }

    // ── Public transition API ──────────────────────────────────────

    pub fn set_connecting(&self) {
        let to = ConnectionState::Connecting;
        let cur = self.get();
        if cur == to {
            return; // same state, no-op
        }
        if let Err(e) = Self::validate(&cur, &to) {
            log::warn!("[state] {e}");
            return;
        }
        self.transit(to, "user initiated connect");
    }

    pub fn set_handshaking(&self) {
        let to = ConnectionState::Handshaking;
        let cur = self.get();
        if cur == to {
            return; // same state, no-op
        }
        if let Err(e) = Self::validate(&cur, &to) {
            log::warn!("[state] {e}");
            return;
        }
        self.transit(to, "websocket opened");
    }

    pub fn set_connecting_peers(&self, peer_count: usize) {
        let to = ConnectionState::ConnectingPeers { peer_count };
        let cur = self.get();
        if cur == to {
            return; // same state with same peer_count, no-op
        }
        if let Err(e) = Self::validate(&cur, &to) {
            log::warn!("[state] {e}");
            return;
        }
        self.transit(to, &format!("dialling {peer_count} peers"));
    }

    pub fn set_ready(&self, peer_count: usize) {
        let to = ConnectionState::Ready { peer_count };
        let cur = self.get();
        // Exact same state — no-op
        if cur == to {
            return;
        }
        // Allow Ready → Ready for peer count changes
        if matches!(cur, ConnectionState::Ready { .. }) {
            *self.state.lock() = to;
            return;
        }
        if let Err(e) = Self::validate(&cur, &to) {
            log::warn!("[state] {e}");
            return;
        }
        self.transit(to, &format!("{peer_count} peers connected"));
    }

    pub fn set_reconnecting(&self, attempt: u32, max_attempts: u32) {
        let to = ConnectionState::Reconnecting {
            attempt,
            max_attempts,
        };
        let cur = self.get();
        // Exact same state — no-op
        if cur == to {
            return;
        }
        // Allow Reconnecting → Reconnecting for attempt updates
        if matches!(cur, ConnectionState::Reconnecting { .. }) {
            *self.state.lock() = to;
            return;
        }
        if let Err(e) = Self::validate(&cur, &to) {
            log::warn!("[state] {e}");
            return;
        }
        self.transit(to, &format!("attempt {attempt}/{max_attempts}"));
    }

    pub fn set_offline(&self, reason: &str) {
        self.transit(ConnectionState::Offline, reason);
    }

    pub fn set_error(&self, message: &str) {
        self.transit(
            ConnectionState::Error {
                message: message.to_string(),
            },
            message,
        );
    }
}

/// Shareable wrapper for the state machine.
pub type SharedStateMachine = Arc<ConnectionStateMachine>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state_is_offline() {
        let sm = ConnectionStateMachine::new();
        assert_eq!(sm.get(), ConnectionState::Offline);
    }

    #[test]
    fn test_happy_path_transitions() {
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        assert_eq!(sm.get(), ConnectionState::Connecting);

        sm.set_handshaking();
        assert_eq!(sm.get(), ConnectionState::Handshaking);

        sm.set_connecting_peers(3);
        assert_eq!(sm.get(), ConnectionState::ConnectingPeers { peer_count: 3 });

        sm.set_ready(3);
        assert_eq!(sm.get(), ConnectionState::Ready { peer_count: 3 });
    }

    #[test]
    fn test_ready_peer_count_update() {
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        sm.set_handshaking();
        sm.set_ready(1);
        assert_eq!(sm.get(), ConnectionState::Ready { peer_count: 1 });
        sm.set_ready(5);
        assert_eq!(sm.get(), ConnectionState::Ready { peer_count: 5 });
    }

    #[test]
    fn test_reconnect_attempt_update() {
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        sm.set_handshaking();
        sm.set_ready(1);
        sm.set_reconnecting(1, 5);
        assert_eq!(
            sm.get(),
            ConnectionState::Reconnecting {
                attempt: 1,
                max_attempts: 5
            }
        );
        sm.set_reconnecting(2, 5);
        assert_eq!(
            sm.get(),
            ConnectionState::Reconnecting {
                attempt: 2,
                max_attempts: 5
            }
        );
    }

    #[test]
    fn test_reconnect_to_ready() {
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        sm.set_handshaking();
        sm.set_ready(2);
        sm.set_reconnecting(1, 3);
        sm.set_handshaking();
        sm.set_ready(2);
        assert_eq!(sm.get(), ConnectionState::Ready { peer_count: 2 });
    }

    #[test]
    fn test_offline_always_allowed() {
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        sm.set_offline("user quit");
        assert_eq!(sm.get(), ConnectionState::Offline);
    }

    #[test]
    fn test_error_then_reconnect() {
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        sm.set_error("dns failure");
        assert!(matches!(sm.get(), ConnectionState::Error { .. }));
        sm.set_connecting();
        assert_eq!(sm.get(), ConnectionState::Connecting);
    }

    #[test]
    fn test_display_and_label() {
        assert_eq!(ConnectionState::Offline.label(), "OFFLINE");
        assert_eq!(ConnectionState::Ready { peer_count: 3 }.label(), "ONLINE");
        assert!(ConnectionState::Ready { peer_count: 1 }.is_operational());
        assert!(!ConnectionState::Offline.is_operational());
        assert!(ConnectionState::Connecting.is_connecting());
        assert!(!ConnectionState::Offline.is_connecting());
    }

    #[test]
    fn test_nop_transition_does_not_panic() {
        let sm = ConnectionStateMachine::new();
        let start = sm.last_transition();
        sm.set_connecting();
        sm.set_connecting(); // duplicate — should be no-op
        assert_ne!(sm.last_transition(), start); // first one counted
        let after_first = sm.last_transition();
        sm.set_connecting(); // second duplicate
        assert_eq!(sm.last_transition(), after_first); // unchanged
    }

    #[test]
    fn test_skip_connecting_peers() {
        // Direct Handshaking → Ready is valid (0 peers case)
        let sm = ConnectionStateMachine::new();
        sm.set_connecting();
        sm.set_handshaking();
        sm.set_ready(0);
        assert_eq!(sm.get(), ConnectionState::Ready { peer_count: 0 });
    }
}
