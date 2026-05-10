from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
import os

load_dotenv()

_client: AsyncIOMotorClient | None = None


def get_db():
    return _client["jsah"]


async def connect():
    global _client
    _client = AsyncIOMotorClient(os.environ["MONGODB_URI"])


async def disconnect():
    if _client:
        _client.close()
