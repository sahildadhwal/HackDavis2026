import os
import sys

# backboard's __init__.py calls parse_args() at import time and will choke on
# uvicorn's CLI arguments. Shield it by temporarily clearing sys.argv.
_argv = sys.argv[:]
sys.argv = sys.argv[:1]
from backboard.client import BackboardClient
sys.argv = _argv

_client: BackboardClient | None = None


def _get_client() -> BackboardClient:
    global _client
    if _client is None:
        _client = BackboardClient(api_key=os.environ.get("BACKBOARD_API_KEY", ""))
    return _client


async def _get_or_create_assistant(user_id: str) -> str:
    """Return assistant_id for this user, persisted in MongoDB."""
    from services.mongo import get_backboard_assistant_id, save_backboard_assistant_id

    assistant_id = await get_backboard_assistant_id(user_id)
    if assistant_id:
        return assistant_id

    client = _get_client()
    assistant = await client.create_assistant(
        name=f"FridgeBridge user {user_id[:8]}",
        description="Remembers recipe preferences for a FridgeBridge user",
        custom_fact_extraction_prompt=(
            "Extract concise preference statements about the user's cooking habits. "
            "Focus on: cuisine style, difficulty level, ingredients they regularly have or lack, dietary patterns. "
            "Each fact should be under 15 words. Examples: "
            "'Prefers quick easy meals under 25 minutes', 'Often missing dairy and basic seasonings'."
        ),
    )
    assistant_id = str(assistant.assistant_id)
    await save_backboard_assistant_id(user_id, assistant_id)
    return assistant_id


async def remember_fact(user_id: str, fact: str) -> None:
    """Store a single distilled fact, skipping near-duplicates."""
    if not user_id or not fact:
        return
    try:
        assistant_id = await _get_or_create_assistant(user_id)
        client = _get_client()
        existing = await client.get_memories(assistant_id)
        for m in existing.memories:
            if fact.lower()[:40] in m.content.lower() or m.content.lower()[:40] in fact.lower():
                print(f"Backboard: skipping duplicate '{fact[:50]}'")
                return
        await client.add_memory(assistant_id, fact)
        print(f"Backboard: stored '{fact}' for {user_id[:8]}")
    except Exception as e:
        print(f"Backboard remember error: {e}")


async def get_user_memory(user_id: str) -> list[str]:
    """Return all memory items stored for this user."""
    if not user_id:
        return []
    try:
        assistant_id = await _get_or_create_assistant(user_id)
        client = _get_client()
        resp = await client.get_memories(assistant_id)
        return [m.content for m in resp.memories]
    except Exception as e:
        print(f"Backboard memory fetch error: {e}")
        return []
