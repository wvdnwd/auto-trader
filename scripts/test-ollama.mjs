import fetch from 'node:http';

async function main() {
  const req = await globalThis.fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5-coder:7b-instruct-q5_K_M',
      prompt: 'Geef in het Nederlands kort 3 krachtige kwantitatieve regels om meer dan 65% winrate te halen in crypto perpetual trading.',
      stream: false,
    }),
  });
  const data = await req.json();
  console.log('\n--- ANTWOORD VAN JE LOKALE OLLAMA OP JE RTX 5070 TI ---\n');
  console.log(data.response);
  console.log(`\nInference tijd: ${(data.total_duration / 1e9).toFixed(2)}s | Tokens: ${data.eval_count} | Snelheid: ${((data.eval_count / (data.eval_duration / 1e9))).toFixed(1)} tokens/sec`);
}

main().catch(console.error);
