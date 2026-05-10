from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone
from dotenv import load_dotenv
from typing import Optional
import os

load_dotenv()

_client: Optional[AsyncIOMotorClient] = None


def get_db():
    return _client["fridgebridge"]


async def connect():
    global _client
    _client = AsyncIOMotorClient(os.environ["MONGODB_URI"])
    db = get_db()
    await db["pantries"].create_index([("location", "2dsphere")])


async def disconnect():
    if _client:
        _client.close()


async def find_pantries_near(lat: float, lng: float, radius_km: float = 20) -> list:
    db = get_db()
    cursor = db["pantries"].find({
        "location": {
            "$near": {
                "$geometry": {"type": "Point", "coordinates": [lng, lat]},
                "$maxDistance": radius_km * 1000,
            }
        }
    }).limit(8)
    pantries = []
    async for doc in cursor:
        pantries.append({
            "id": str(doc["_id"]),
            "name": doc["name"],
            "address": doc["address"],
            "phone": doc.get("phone", ""),
            "hours": doc.get("hours", ""),
            "notes": doc.get("notes", ""),
            "lat": doc["location"]["coordinates"][1],
            "lng": doc["location"]["coordinates"][0],
        })
    return pantries


async def get_backboard_assistant_id(user_id: str) -> Optional[str]:
    db = get_db()
    doc = await db["user_assistants"].find_one({"user_id": user_id})
    return doc["assistant_id"] if doc else None


async def save_backboard_assistant_id(user_id: str, assistant_id: str) -> None:
    db = get_db()
    await db["user_assistants"].update_one(
        {"user_id": user_id},
        {"$set": {"assistant_id": assistant_id}},
        upsert=True,
    )


async def insert_pantries(pantries: list) -> int:
    """Insert pantries that don't already exist (matched by name). Returns count inserted."""
    db = get_db()
    inserted = 0
    for p in pantries:
        exists = await db["pantries"].find_one({"name": p["name"]})
        if not exists:
            await db["pantries"].insert_one(p)
            inserted += 1
    return inserted


async def log_call(pantry_name: str, available: list, unavailable: list):
    db = get_db()
    await db["call_history"].insert_one({
        "pantry_name": pantry_name,
        "available": [i if isinstance(i, str) else i.get("item", str(i)) for i in available],
        "unavailable": [i if isinstance(i, str) else i.get("item", str(i)) for i in unavailable],
        "timestamp": datetime.now(timezone.utc),
    })


async def get_recent_notes(pantry_names: list) -> dict:
    if not pantry_names:
        return {}
    db = get_db()
    notes = {}
    for name in pantry_names:
        doc = await db["call_history"].find_one(
            {"pantry_name": name},
            sort=[("timestamp", -1)]
        )
        if not doc:
            continue
        delta = datetime.now(timezone.utc) - doc["timestamp"].replace(tzinfo=timezone.utc)
        days = delta.days
        age = "today" if days == 0 else "yesterday" if days == 1 else f"{days} days ago"
        available = doc.get("available", [])
        if available:
            notes[name] = f"had {', '.join(available[:2])} · {age}"
        else:
            notes[name] = f"nothing available · {age}"
    return notes