# coding:utf8
"""
WebRTC DataChannel-based P2P file transfer module for the Syncplay desktop client.

This module provides WebRTC signaling support for file transfers. Currently,
when aiortc is not installed, it returns a no-op handler. Full WebRTC DataChannel
support requires aiortc (pip install aiortc) and integration with the Twisted
event loop.

Architecture:
- is_webrtc_available() -> bool: Returns True if aiortc + dependencies are installed.
- get_webrtc_transfer_handler(client) -> WebRTCTransferHandler | None: Returns a handler
  that processes SDP/ICE signaling messages.
"""


def is_webrtc_available():
    """Check whether WebRTC support is available (aiortc installed)."""
    try:
        import aiortc  # noqa: F401
        return True
    except ImportError:
        return False


class WebRTCTransferHandler(object):
    """Handles WebRTC signaling (SDP/ICE) for file transfers.

    This is a placeholder. When aiortc is installed, this will be replaced
    with a full implementation that:
    1. Creates RTCPeerConnection
    2. Exchanges SDP offers/answers via the Syncplay signaling channel
    3. Transfers file data over DataChannel instead of TCP relay
    """

    def __init__(self, client):
        self._client = client
        self._sessions = {}

    def handle_sdp(self, transfer_id, sdp_data, role):
        """Handle an incoming SDP offer or answer.

        Args:
            transfer_id: The transfer session ID.
            sdp_data: Dict with 'type' (offer/answer) and 'sdp' (SDP string).
            role: 'offer' or 'answer'.
        """
        self._client.ui.showDebugMessage(
            "WebRTC: SDP {} for transfer {} received (aiortc not installed, ignoring)".format(
                role, transfer_id
            )
        )

    def handle_ice(self, transfer_id, ice_data):
        """Handle an incoming ICE candidate.

        Args:
            transfer_id: The transfer session ID.
            ice_data: Dict with candidate, sdpMid, sdpMLineIndex.
        """
        self._client.ui.showDebugMessage(
            "WebRTC: ICE candidate for transfer {} received (aiortc not installed, ignoring)".format(
                transfer_id
            )
        )

    def initiate_transfer(self, transfer_id, role, file_info):
        """Initiate a WebRTC transfer.

        Called after the ticket is received if both peers support WebRTC.
        When aiortc is available, this creates an RTCPeerConnection and
        starts the signaling exchange.

        Args:
            transfer_id: The transfer session ID.
            role: 'sender' or 'receiver'.
            file_info: Dict with file name, size, etc.
        """
        self._client.ui.showDebugMessage(
            "WebRTC: Initiate transfer {} as {} (aiortc not installed, falling back to TCP)".format(
                transfer_id, role
            )
        )
        return False


_handler_instance = None


def get_webrtc_transfer_handler(client):
    """Get or create the WebRTC transfer handler singleton.

    Args:
        client: The Syncplay client instance.

    Returns:
        WebRTCTransferHandler or None if aiortc is not installed.
    """
    if not is_webrtc_available():
        return None
    global _handler_instance
    if _handler_instance is None:
        _handler_instance = WebRTCTransferHandler(client)
    return _handler_instance
