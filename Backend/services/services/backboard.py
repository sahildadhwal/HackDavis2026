import os
from backboard import BackboardClient
from services.mongo import get_db

client = BackboardClient(api_key=os.environ["BACKBOARD_API_KEY"])


async def suggest_meals(household_id: str, ingredients: list[str]) -> dict:
    db = get_db()
    household = await db["households"].find_one({"_id": household_id})
    thread_id = household.get("thread_id") if household else None

    prompt = f"The user has these ingredients: {', '.join(ingredients)}. Suggest meals they can make tonight and list what key ingredients are missing."

    response = await client.send_message(
        prompt,
        thread_id=thread_id,
        memory="Auto",
    )

    await db["households"].update_one(
        {"_id": household_id},
        {"$set": {"thread_id": response.thread_id}},
        upsert=True,
    )

    return {"content": response.content, "thread_id": response.thread_id}
