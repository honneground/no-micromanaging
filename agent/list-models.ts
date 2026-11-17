// Lists the model IDs your key can use. Never prints the key.
import { BASE_URL, client } from "./2-model.js";

const models = await client.models.list();
console.log(`Models at ${BASE_URL}:`);
for (const m of models.data) console.log(` - ${m.id}`);
