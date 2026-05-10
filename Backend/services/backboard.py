import os
import sys

# backboard's __init__.py calls parse_args() at import time and will choke on
# uvicorn's CLI arguments. Shield it by temporarily clearing sys.argv.
_argv = sys.argv[:]
sys.argv = sys.argv[:1]
from backboard.client import BackboardClient
sys.argv = _argv

_client: BackboardClient | None = None

# user_id → assistant_id (string)
_assistants: dict[str, str] = {}


def _get_client() -> BackboardClient:
    global _client
    if _client is None:
        _client = BackboardClient(api_key=os.environ.get("BACKBOARD_API_KEY", ""))
    return _client


async def _get_or_create_assistant(user_id: str) -> str:
    """Return the Backboard assistant_id for this user, creating one if needed."""
    if user_id in _assistants:
        return _assistants[user_id]
    client = _get_client()
    assistant = await client.create_assistant(
        name=f"FridgeBridge user {user_id[:8]}",
        description="Remembers recipe preferences for a FridgeBridge user",
    )
    _assistants[user_id] = str(assistant.assistant_id)
    return _assistants[user_id]


async def remember_event(user_id: str, event: str) -> None:
    """Send an event through Backboard so its LLM extracts structured memories."""
    if not user_id:
        return
    try:
        assistant_id = await _get_or_create_assistant(user_id)
        client = _get_client()
        await client.send_message(
            event,
            assistant_id=assistant_id,
            memory="Auto",
        )
    except Exception as e:
        print(f"Backboard remember error: {e}")


async def get_user_memory(user_id: str) -> list[str]:
    """Return all memory items stored for this user."""
    if not user_id or user_id not in _assistants:
        return []
    try:
        client = _get_client()
        resp = await client.get_memories(_assistants[user_id])
        return [m.content for m in resp.memories]
    except Exception as e:
        print(f"Backboard memory fetch error: {e}")
        return []
