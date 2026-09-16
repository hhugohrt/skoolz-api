import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 4010);

app.listen(PORT, () => {
  console.log(`Skoolz API prête sur http://localhost:${PORT}`);
});
