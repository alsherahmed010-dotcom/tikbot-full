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
    headers = {
        "User-Agent": "okhttp/4.12.0",
        "Accept-Encoding": "gzip",
        "device-number": ''.join(random.choices('0123456789abcdef', k=16)),
        "platform": "tiktok",
        "app-version": "22",
        "accept-language": "en",
    }
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers

def get_fid(username):
    url = f"{TIKSTAR_BASE}/users/tiktok/{username}"
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}
    headers = get_headers(REGISTRATION_TOKEN)
    
    try:
        resp = requests.post(url, params={"include": "account"}, data=payload, headers=headers, timeout=20)
        if resp.status_code in (200, 201):
            data = resp.json()
            fid = data.get("fid")
            user_id = data.get("id")
            print(f"✅ FID: {fid}")
            print(f"✅ ID: {user_id}")
            return str(fid), str(user_id)
        else:
            print(f"❌ Status: {resp.status_code}")
            print(resp.text[:200])
    except Exception as e:
        print(f"❌ Error: {e}")
    
    return None, None

def login(fid):
    url = f"{TIKSTAR_BASE}/auth"
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "scope": "*", "username": str(fid), "password": "password", "grant_type": "password"}
    
    try:
        resp = requests.post(url, data=payload, headers=get_headers(REGISTRATION_TOKEN), timeout=20)
        if resp.status_code in (200, 201):
            data = resp.json()
            token = data.get("access_token")
            if token:
                print("✅ Login OK")
                return token
        else:
            print(f"❌ Login status: {resp.status_code}")
            print(resp.text[:200])
    except Exception as e:
        print(f"❌ Login error: {e}")
    
    return None

def get_video(token, user_id):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/videos/rand", params={"user_id": str(user_id)}, headers=get_headers(token), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            vid = data.get("id")
            coins = data.get("meta", {}).get("coins", 0)
            return vid, coins
    except Exception as e:
        print(f"❌ Video error: {e}")
    return None, 0

def submit_view(token, post_id):
    try:
        resp = requests.post(f"{TIKSTAR_BASE}/viewvideos", data={"post_id": str(post_id)}, headers=get_headers(token), timeout=15)
        if resp.status_code in (200, 201):
            data = resp.json()
            coins = data.get("amount", {}).get("amount", 0)
            return int(coins)
    except Exception as e:
        print(f"❌ Submit error: {e}")
    return 0

def main():
    username = sys.argv[1] if len(sys.argv) > 1 else input("Username: ")
    account_id = sys.argv[2] if len(sys.argv) > 2 else "0"
    username = username.replace("@", "").strip()
    
    print(f"🚀 Starting for @{username}")
    
    fid, user_id = get_fid(username)
    if not fid:
        print("❌ Failed to get FID")
        return
    
    token = login(fid)
    if not token:
        print("❌ Failed to login")
        return
    
    total = 0
    delay = 8
    
    while True:
        try:
            video_id, video_coins = get_video(token, user_id)
            if not video_id:
                time.sleep(delay)
                continue
            
            print(f"📹 Video: {video_id} (coins: {video_coins})")
            time.sleep(delay)
            
            earned = submit_view(token, video_id)
            if earned > 0:
                total += earned
                print(f"✅ Earned: {earned} | Total: {total}")
                
                try:
                    requests.post(f"http://localhost:8080/api/update-coins/{account_id}", json={"coins": earned}, timeout=5)
                except:
                    pass
            else:
                print("❌ No coins")
            
            time.sleep(delay)
        except KeyboardInterrupt:
            print(f"\n💰 Total: {total}")
            break
        except Exception as e:
            print(f"❌ Error: {e}")
            time.sleep(delay)

if __name__ == "__main__":
    main()
