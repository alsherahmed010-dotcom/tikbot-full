import requests
import time
import sys
import json
import random

TIKSTAR_BASE = "https://api.tikstarapp.xyz/api/tikstar"
CLIENT_ID = "16"
CLIENT_SECRET = "3ZhY6sI2KhJ4iftS3IlFAypFT1m7dQMe1keSjTqF"
REGISTRATION_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxNiIsImp0aSI6IjMxYzZlOWFkZWE4ZjYxOGVhMTQzMTM1YWJhNDg4NmYyYmEzZjU5OTExNzkyYWM3ZGNlMmY2YWJjYzNmMzUxY2UxYzY4MTk4ZWY5ZTE2M2Q5IiwiaWF0IjoxNzYyMDYxODYwLjE1MzE4MywibmJmIjoxNzYyMDYxODYwLjE1MzE4NSwiZXhwIjoyMDc3NTk0NjYwLjE0OTQ4Niwic3ViIjoiIiwic2NvcGVzIjpbIioiXX0.XB7kc0sHW34lcIhvrDvFdWgyJK03lUzTegpv0FJMGN1RVD1HNCoJvOoBsoxLwu16LQaEZonfD2qcAW9oHhEbdMBHRDFtkFM1vszd0xB5crHpXJ526NSJ_xATelTJtomrs-UhRFov_rUD1ZDPWFrp9yger8QwsPYxEUogVlBcuxC23-I71un7Km5kPHglJ_exsPNPJOy1rxw_eQu774T0qGUHWM6LW-pQni3nOcfp3AZ6C-2XTorFMpj64f8nxIVb0gW20QDxUQ9f15qbaxeX85Xa67EHE1gpWt7gKQPhs7TRmbThZs4XmW3DKAv-0A8_0azoLX_s4xMhG9Ul2A-_1Fj_yVCVQkaIhzJkXHqKP-L7lDUNF4oBVNgKUKILzdWRq-IeefYzpocsd_rEiwB4ZeYCiEYdMFHHcKZt5Sf4Zjvl25uhjXzLEhbjjGlDx0jBOuPo4EHBccGtn1EvfAJSYkStCXQ-z7Bko4362G6hqdnFTp-YVjz8IpbzP_gA5UsUhRrAdgjRi6GEbdQWs2LTJKadpfq592MF_Umcg1MpSCt-vSQi7q2JKwZxBINT-p6APJckkQ_9Dmo2wZbtb2UwQoZP_Fh4YtI2ZGocrcR2OZojhY1nmhVPAe4hlPUZmEVQKX2SSA-_ADp07-gM30Zhy0bUFpJqxlKipYzLBoL92BM"

def get_headers(token=None):
    return {
        "User-Agent": "okhttp/4.12.0",
        "Accept-Encoding": "gzip",
        "device-number": ''.join(random.choices('0123456789abcdef', k=16)),
        "platform": "tiktok",
        "app-version": "22",
        "accept-language": "en",
        **({"authorization": f"Bearer {token}"} if token else {})
    }

def get_fid(username):
    url = f"{TIKSTAR_BASE}/users/tiktok/{username}"
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}
    try:
        resp = requests.post(url, params={"include": "account"}, data=payload, headers=get_headers(REGISTRATION_TOKEN), timeout=20)
        if resp.status_code in (200, 201):
            data = resp.json()
            return str(data.get("fid")), str(data.get("id"))
    except:
        pass
    return None, None

def login(fid):
    url = f"{TIKSTAR_BASE}/auth"
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "scope": "*", "username": str(fid), "password": "password", "grant_type": "password"}
    try:
        resp = requests.post(url, data=payload, headers=get_headers(REGISTRATION_TOKEN), timeout=20)
        if resp.status_code in (200, 201):
            token = resp.json().get("access_token")
            if token:
                return token
    except:
        pass
    return None

def get_coins(token):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/user", params={"include": "account"}, headers=get_headers(token), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            return int(data.get("account", {}).get("amount", {}).get("amount", 0))
    except:
        pass
    return 0

def main():
    username = sys.argv[1] if len(sys.argv) > 1 else input("Username: ")
    account_id = sys.argv[2] if len(sys.argv) > 2 else "0"
    username = username.replace("@", "").strip()
    
    print(f"🚀 Starting for @{username}")
    
    fid, _ = get_fid(username)
    if not fid:
        print("❌ Failed FID")
        return
    
    token = login(fid)
    if not token:
        print("❌ Failed login")
        return
    
    while True:
        try:
            coins = get_coins(token)
            print(f"💰 Coins: {coins}")
            
            # تحديث السيرفر
            requests.post(
                f"http://localhost:8080/api/update-coins/{account_id}",
                json={"coins": coins},
                timeout=5
            )
            
            time.sleep(30)
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(10)

if __name__ == "__main__":
    main()
