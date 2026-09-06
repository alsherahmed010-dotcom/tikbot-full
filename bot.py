import requests
import time
import sys
import json
import base64
import random
import os
import hashlib

GREEN = "\033[92m"; RED = "\033[91m"; YELLOW = "\033[93m"; RESET = "\033[0m"

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

TIKSTAR_BASE = "https://api.tikstarapp.xyz/api/tikstar"
CLIENT_ID = "16"
CLIENT_SECRET = "3ZhY6sI2KhJ4iftS3IlFAypFT1m7dQMe1keSjTqF"
APP_VERSION = "22"
PLATFORM = "tiktok"

REGISTRATION_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxNiIsImp0aSI6IjMxYzZlOWFkZWE4ZjYxOGVhMTQzMTM1YWJhNDg4NmYyYmEzZjU5OTExNzkyYWM3ZGNlMmY2YWJjYzNmMzUxY2UxYzY4MTk4ZWY5ZTE2M2Q5IiwiaWF0IjoxNzYyMDYxODYwLjE1MzE4MywibmJmIjoxNzYyMDYxODYwLjE1MzE4NSwiZXhwIjoyMDc3NTk0NjYwLjE0OTQ4Niwic3ViIjoiIiwic2NvcGVzIjpbIioiXX0.XB7kc0sHW34lcIhvrDvFdWgyJK03lUzTegpv0FJMGN1RVD1HNCoJvOoBsoxLwu16LQaEZonfD2qcAW9oHhEbdMBHRDFtkFM1vszd0xB5crHpXJ526NSJ_xATelTJtomrs-UhRFov_rUD1ZDPWFrp9yger8QwsPYxEUogVlBcuxC23-I71un7Km5kPHglJ_exsPNPJOy1rxw_eQu774T0qGUHWM6LW-pQni3nOcfp3AZ6C-2XTorFMpj64f8nxIVb0gW20QDxUQ9f15qbaxeX85Xa67EHE1gpWt7gKQPhs7TRmbThZs4XmW3DKAv-0A8_0azoLX_s4xMhG9Ul2A-_1Fj_yVCVQkaIhzJkXHqKP-L7lDUNF4oBVNgKUKILzdWRq-IeefYzpocsd_rEiwB4ZeYCiEYdMFHHcKZt5Sf4Zjvl25uhjXzLEhbjjGlDx0jBOuPo4EHBccGtn1EvfAJSYkStCXQ-z7Bko4362G6hqdnFTp-YVjz8IpbzP_gA5UsUhRrAdgjRi6GEbdQWs2LTJKadpfq592MF_Umcg1MpSCt-vSQi7q2JKwZxBINT-p6APJckkQ_9Dmo2wZbtb2UwQoZP_Fh4YtI2ZGocrcR2OZojhY1nmhVPAe4hlPUZmEVQKX2SSA-_ADp07-gM30Zhy0bUFpJqxlKipYzLBoL92BM"

def get_headers(token=None):
    headers = {
        "User-Agent": "okhttp/4.12.0",
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "device-number": ''.join(random.choices('0123456789abcdef', k=16)),
        "platform": PLATFORM,
        "app-version": APP_VERSION,
        "accept-language": "en"
    }
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers

def get_fid(username):
    url = f"{TIKSTAR_BASE}/users/tiktok/{username}"
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}
    try:
        resp = requests.post(url, params={"include": "account"}, data=payload, headers=get_headers(REGISTRATION_TOKEN), timeout=20)
        if resp.status_code in (200, 201):
            data = resp.json()
            fid = data.get("fid") or data.get("data", {}).get("fid")
            uid = data.get("id") or data.get("data", {}).get("id")
            return str(fid) if fid else None, str(uid) if uid else None
    except Exception as e:
        print(f"{RED}❌ FID Error: {e}{RESET}")
    return None, None

def login(fid):
    url = f"{TIKSTAR_BASE}/auth"
    payload = {
        "client_id": CLIENT_ID, 
        "client_secret": CLIENT_SECRET, 
        "scope": "*", 
        "username": str(fid), 
        "password": "password", 
        "grant_type": "password"
    }
    try:
        resp = requests.post(url, data=payload, headers=get_headers(REGISTRATION_TOKEN), timeout=20)
        if resp.status_code in (200, 201):
            token = resp.json().get("access_token")
            if token:
                return token
    except Exception as e:
        print(f"{RED}❌ Login Error: {e}{RESET}")
    return None

def get_random_video(token, user_id):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/videos/rand", params={"user_id": str(user_id)}, headers=get_headers(token), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            return data.get("id") or data.get("data", {}).get("id")
    except:
        pass
    return None

def submit_view(token, post_id):
    try:
        resp = requests.post(f"{TIKSTAR_BASE}/viewvideos", data={"post_id": str(post_id)}, headers=get_headers(token), timeout=15)
        if resp.status_code in (200, 201):
            data = resp.json()
            amount = data.get("amount", {})
            if isinstance(amount, dict):
                return int(amount.get("amount", 0))
            return int(amount)
    except:
        pass
    return 0

def get_random_post(token, user_id):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/posts/rand", params={"user_id": str(user_id)}, headers=get_headers(token), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            return data.get("id") or data.get("data", {}).get("id")
    except:
        pass
    return None

def like_post(token, post_id):
    try:
        resp = requests.post(f"{TIKSTAR_BASE}/likeposts", data={"post_ids": str(post_id)}, headers=get_headers(token), timeout=15)
        if resp.status_code in (200, 201):
            data = resp.json()
            amount = data.get("amount", {})
            if isinstance(amount, dict):
                return int(amount.get("amount", 0))
            return int(amount)
    except:
        pass
    return 0

def get_coins(token):
    try:
        resp = requests.get(f"{TIKSTAR_BASE}/user", params={"include": "account"}, headers=get_headers(token), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            acc = data.get("account", {}) or data.get("data", {}).get("account", {})
            amt = acc.get("amount", {})
            if isinstance(amt, dict):
                return int(amt.get("amount", 0))
            return int(amt)
    except:
        pass
    return 0

def update_backend(account_id, coins):
    if account_id and account_id != "0":
        try:
            requests.post(f"http://localhost:8080/api/update-coins/{account_id}", json={"coins": coins}, timeout=5)
        except:
            pass

def main():
    username = sys.argv[1] if len(sys.argv) > 1 else input("Username: ")
    account_id = sys.argv[2] if len(sys.argv) > 2 else "0"
    username = username.replace("@", "").strip()
    
    print(f"{GREEN}🚀 Starting TikBot for @{username}{RESET}")
    
    fid, user_id = get_fid(username)
    if not fid:
        print(f"{RED}❌ Failed to fetch FID for @{username}{RESET}")
        return
    
    token = login(fid)
    if not token:
        print(f"{RED}❌ Failed to Login for @{username}{RESET}")
        return
    
    if not user_id:
        user_id = "2642027"
    
    print(f"{GREEN}✅ Authenticated successfully! User ID: {user_id}{RESET}")
    
    total_earned = 0
    delay = 6
    fail_count = 0
    mode = "video"
    
    while True:
        try:
            current_coins = get_coins(token)
            print(f"💰 Current Account Coins: {GREEN}{current_coins}{RESET}")
            update_backend(account_id, current_coins)
            
            earned = 0
            if mode == "video":
                video_id = get_random_video(token, user_id)
                if video_id:
                    time.sleep(delay)
                    earned = submit_view(token, video_id)
                    if earned > 0:
                        total_earned += earned
                        fail_count = 0
                        print(f"{GREEN}✅ Video View Success: +{earned} Coins | Total Earned: {total_earned}{RESET}")
                    else:
                        fail_count += 1
                else:
                    fail_count += 1
                
                if fail_count >= 3:
                    mode = "like"
                    fail_count = 0
                    print(f"{YELLOW}🔄 Switching mode to Likes...{RESET}")
            
            elif mode == "like":
                post_id = get_random_post(token, user_id)
                if post_id:
                    time.sleep(delay)
                    earned = like_post(token, post_id)
                    if earned > 0:
                        total_earned += earned
                        fail_count = 0
                        print(f"{GREEN}✅ Post Like Success: +{earned} Coins | Total Earned: {total_earned}{RESET}")
                    else:
                        fail_count += 1
                else:
                    fail_count += 1
                
                if fail_count >= 3:
                    mode = "video"
                    fail_count = 0
                    print(f"{YELLOW}🔄 Switching mode to Videos...{RESET}")
            
            time.sleep(delay)
            
        except KeyboardInterrupt:
            print(f"\n{GREEN}💰 Final total earned in session: {total_earned}{RESET}")
            break
        except Exception as e:
            print(f"{RED}⚠️ Error encountered: {e}{RESET}")
            time.sleep(10)

if __name__ == "__main__":
    main()
