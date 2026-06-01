sudo systemctl daemon-reload

cd /opt/scenariobot

/home/lior/.deno/bin/deno run \
  --allow-net \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-run \
  deno_compile_server.ts


  
🦕 Deno compile server running on :8765
<

curl -m 10 -X POST http://localhost:8765 \
  -H "Content-Type: application/json" \
  -d '{"card_type":"sender","code":"export default async function(payload: unknown){ return { success: true }; }"}'
