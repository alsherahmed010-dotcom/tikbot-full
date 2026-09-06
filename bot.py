import requests
import time
import sys
import json
import base64
import random
import os
import hashlib

GREEN = "\033[92m";RED = "\033[91m";YELLOW = "\033[93m";RESET = "\033[0m"
keyie = "1688b7ca5531cfbd4a8f11cefa72d1fb"

_SIGN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sign")
if not os.path.isdir(_SIGN_DIR):
    _SIGN_DIR = os.path.join(os.getcwd(), "sign")
if _SIGN_DIR not in sys.path:
    sys.path.insert(0, os.path.dirname(_SIGN_DIR))

try:
    from sign import sign_mobile_request, make_seed_device
    _SIGN_DEVICE = make_seed_device()
    _SIGN_OK = True
except Exception as e:
    _SIGN_OK = False
    _SIGN_ERR = str(e)

TIKTOK_API_BASE = "https://api16-normal-c-useast1a.tiktokv.com"
TIKTOK_AID = "1233"
TIKSTAR_BASE = "https://api.tikstarapp.xyz/api/tikstar"
CLIENT_ID = "16"
CLIENT_SECRET = "3ZhY6sI2KhJ4iftS3IlFAypFT1m7dQMe1keSjTqF"
APP_VERSION = "22"
PLATFORM = "tiktok"
REGISTRATION_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxNiIsImp0aSI6IjMxYzZlOWFkZWE4ZjYxOGVhMTQzMTM1YWJhNDg4NmYyYmEzZjU5OTExNzkyYWM3ZGNlMmY2YWJjYzNmMzUxY2UxYzY4MTk4ZWY5ZTE2M2Q5IiwiaWF0IjoxNzYyMDYxODYwLjE1MzE4MywibmJmIjoxNzYyMDYxODYwLjE1MzE4NSwiZXhwIjoyMDc3NTk0NjYwLjE0OTQ4Niwic3ViIjoiIiwic2NvcGVzIjpbIioiXX0.XB7kc0sHW34lcIhvrDvFdWgyJK03lUzTegpv0FJMGN1RVD1HNCoJvOoBsoxLwu16LQaEZonfD2qcAW9oHhEbdMBHRDFtkFM1vszd0xB5crHpXJ526NSJ_xATelTJtomrs-UhRFov_rUD1ZDPWFrp9yger8QwsPYxEUogVlBcuxC23-I71un7Km5kPHglJ_exsPNPJOy1rxw_eQu774T0qGUHWM6LW-pQni3nOcfp3AZ6C-2XTorFMpj64f8nxIVb0gW20QDxUQ9f15qbaxeX85Xa67EHE1gpWt7gKQPhs7TRmbThZs4XmW3DKAv-0A8_0azoLX_s4xMhG9Ul2A-_1Fj_yVCVQkaIhzJkXHqKP-L7lDUNF4oBVNgKUKILzdWRq-IeefYzpocsd_rEiwB4ZeYCiEYdMFHHcKZt5Sf4Zjvl25uhjXzLEhbjjGlDx0jBOuPo4EHBccGtn1EvfAJSYkStCXQ-z7Bko4362G6hqdnFTp-YVjz8IpbzP_gA5UsUhRrAdgjRi6GEbdQWs2LTJKadpfq592MF_Umcg1MpSCt-vSQi7q2JKwZxBINT-p6APJckkQ_9Dmo2wZbtb2UwQoZP_Fh4YtI2ZGocrcR2OZojhY1nmhVPAe4hlPUZmEVQKX2SSA-_ADp07-gM30Zhy0bUFpJqxlKipYzLBoL92BM"

def get_base_headers():
    return {
        "User-Agent": "okhttp/4.12.0",
        "Accept-Encoding": "gzip",
        "device-number": ''.join(random.choices('0123456789abcdef', k=16)),
        "platform": PLATFORM,
        "app-version": APP_VERSION,
        "accept-language": "en",
    }

def get_auth_headers(token=None):
    headers = get_base_headers()
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers

def get_fid_from_username(username):
    url = f"{TIKSTAR_BASE}/users/tiktok/{username}"
    params = {"include": "account"}
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}
    
    for attempt in range(3):
        try:
            resp = requests.post(url, params=params, data=payload, headers=get_auth_headers(REGISTRATION_TOKEN), timeout=20)
            if resp.status_code in (200, 201):
                data = resp.json()
                return data.get("fid") or data.get("b"), data.get("id") or data.get("a"), data
        except:
            time.sleep(3)
    return None, None, None

def login_with_tiktok_fid(fid):
    url = f"{TIKSTAR_BASE}/auth"
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "scope": "*", "username": str(fid), "password": "password", "grant_type": "password"}
    
    for attempt in range(3):
        try:
            resp = requests.post(url, data=payload, headers=get_auth_headers(REGISTRATION_TOKEN), timeout=20)
            data = resp.json()
            if "access_token" in data:
                return data["access_token"], None
        except:
            time.sleep(3)
    return None, None

def get_random_video(token, user_id):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/videos/rand", params={"user_id": str(user_id)}, headers=get_auth_headers(token), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            return {"id": data.get("id"), "coins": data.get("meta", {}).get("coins", 0)}
    except:
        pass
    return None

def submit_video_view(token, post_id):
    try:
        resp = requests.post(f"{TIKSTAR_BASE}/viewvideos", data={"post_id": str(post_id)}, headers=get_auth_headers(token), timeout=15)
        if resp.status_code in (200, 201):
            return True, resp.json().get("amount", {}).get("amount", 0)
    except:
        pass
    return False, 0

def get_user_coins(token):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/user", params={"include": "account"}, headers=get_auth_headers(token), timeout=15)
        if resp.status_code == 200:
            return resp.json().get("account", {}).get("amount", {}).get("amount", 0)
    except:
        pass
    return 0

def main():
    username = sys.argv[1] if len(sys.argv) > 1 else input("Username: ")
    account_id = sys.argv[2] if len(sys.argv) > 2 else "0"
    
    print(f"Starting bot for @{username}")
    
    fid, tikstar_id, _ = get_fid_from_username(username)
    if not fid:
        print("Failed to get FID")
        return
    
    token, _ = login_with_tiktok_fid(fid)
    if not token:
        print("Failed to login")
        return
    
    coins = get_user_coins(token)
    print(f"Current coins: {coins}")
    
    total_earned = 0
    delay = 8
    
    while True:
        video = get_random_video(token, tikstar_id or "2642027")
        if not video:
            time.sleep(delay)
            continue
        
        time.sleep(delay)
        success, earned = submit_video_view(token, video["id"])
        
        if success:
            total_earned += earned
            print(f"✅ Earned: {earned} | Total: {total_earned}")
            
            # Update DB
            try:
                requests.post(f"http://localhost:8080/api/update-coins/{account_id}", json={"coins": earned})
            except:
                pass
        else:
            print("❌ Failed")
        
        time.sleep(delay)

if __name__ == "__main__":
    main()
