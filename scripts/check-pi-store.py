import json
import sys
import paramiko

sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.1.91', username='spiceprice')

sftp = ssh.open_sftp()
with sftp.open('traderr/data/store-main.json', 'r') as f:
    data = json.load(f)

print("=== POSITIONS IN PI STORE-MAIN.JSON ===")
positions = data.get('positions', [])
print(f"Total positions: {len(positions)}")
for p in positions:
    print(f"  ID: {p.get('id')}, Symbol: {p.get('symbol')}, Status: {p.get('status')}, Live: {p.get('live')}")

print("\n=== RECENT EVENTS IN PI STORE-MAIN.JSON ===")
events = data.get('events', [])
print(f"Total events: {len(events)}")
for e in events[-15:]:
    print(f"  [{e.get('level')}] {e.get('message')}")

ssh.close()
