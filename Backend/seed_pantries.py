"""
Run once to seed the pantries collection:
  cd Backend
  python seed_pantries.py
"""

import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
import os

load_dotenv()

PANTRIES = [
    {
        "name": "HackDavis Demo Pantry 1",
        "address": "UC Davis, Davis, CA 95616",
        "phone": "+17078632820",
        "hours": "Open Now",
        "notes": "Demo pantry for HackDavis 2026",
        "location": {"type": "Point", "coordinates": [-121.7617, 38.5382]},
    },
    {
        "name": "HackDavis Demo Pantry 2",
        "address": "UC Davis, Davis, CA 95616",
        "phone": "+14088079857",
        "hours": "Open Now",
        "notes": "Demo pantry for HackDavis 2026",
        "location": {"type": "Point", "coordinates": [-121.7618, 38.5382]},
    },
    {
        "name": "Yolo County Food Bank",
        "address": "233 Harter Ave, Woodland, CA 95776",
        "phone": "+15306682860",
        "hours": "Mon–Fri 8am–4pm",
        "notes": "",
        "location": {"type": "Point", "coordinates": [-121.7743, 38.6763]},
    },
    {
        "name": "UC Davis Pantry",
        "address": "East Quad, Davis, CA 95616",
        "phone": "+15307528000",
        "hours": "Mon–Fri 10am–5pm",
        "notes": "Students and community members welcome",
        "location": {"type": "Point", "coordinates": [-121.7488, 38.5382]},
    },
    {
        "name": "Davis Community Meals",
        "address": "1111 H St, Davis, CA 95616",
        "phone": "+15307535778",
        "hours": "Mon/Wed/Fri 5:30–6:30pm",
        "notes": "Hot meals and pantry items",
        "location": {"type": "Point", "coordinates": [-121.7406, 38.5449]},
    },
    {
        "name": "STEAC Food Closet",
        "address": "1100 Olive Dr, Davis, CA 95616",
        "phone": "+15307535830",
        "hours": "Tue & Thu 4–6pm",
        "notes": "",
        "location": {"type": "Point", "coordinates": [-121.7512, 38.5601]},
    },
]


async def seed():
    client = AsyncIOMotorClient(os.environ["MONGODB_URI"])
    db = client["fridgebridge"]
    collection = db["pantries"]
    await collection.drop()
    await collection.create_index([("location", "2dsphere")])
    await collection.insert_many(PANTRIES)
    count = await collection.count_documents({})
    print(f"Seeded {count} pantries.")
    client.close()


asyncio.run(seed())
