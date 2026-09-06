import requests
import time
import sys
import json
import base64
import random
import os
import hashlib
GREEN = "\033[92m";RED = "\033[91m";YELLOW = "\033[93m";RESET = "\033[0m";keyie = "1688b7ca5531cfbd4a8f11cefa72d1fb";_SIGN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sign")
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

def _build_tiktok_headers(signed_headers, device):
    return {
        "X-SS-STUB": signed_headers.get("X-SS-STUB", ""),
        "X-Khronos": signed_headers.get("X-Khronos", ""),
        "X-Gorgon": signed_headers.get("X-Gorgon", ""),
        "X-Argus": signed_headers.get("X-Argus", ""),
        "X-Ladon": signed_headers.get("X-Ladon", ""),
        "User-Agent": f"com.zhiliaoapp.musically/{device.app_version} "
                     f"(Linux; U; Android {device.os_version}; en_US; "
                     f"{device.device_type}; Build/TP1A; Cronet/58.0.2991.0)",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": f"sessionid={keyie}; "
                  f"install_id={device.install_id}; "
                  f"iid={device.iid}; "
                  f"odin_tt=00000000000000000000000000000000",
    }


def tiktok_follow(tiktok_user_id):
    if not _SIGN_OK:
        print(f"{RED}[TIKTOK] sign module error: {_SIGN_ERR}{RESET}")
        return False
    url = f"{TIKTOK_API_BASE}/aweme/v1/commit/follow/user/"
    params = {
        "user_id": str(tiktok_user_id),
        "type": "1",
        "qid": "0",
        "aid": TIKTOK_AID,
        "device_id": str(_SIGN_DEVICE.device_id),
        "iid": str(_SIGN_DEVICE.iid),
        "install_id": str(_SIGN_DEVICE.install_id),
    }

    try:
        signed = sign_mobile_request(
            method="POST",
            path="/aweme/v1/commit/follow/user/",
            body={},
            device=_SIGN_DEVICE,
            params=params,
            return_headers=True,
        )

        headers = _build_tiktok_headers(signed, _SIGN_DEVICE)
        resp = requests.post(url, params=params, headers=headers, timeout=20)
        data = resp.json()
        
        status_code = data.get("status_code", -1)
        follow_status = data.get("follow_status", -1)
        
        if status_code == 0 or follow_status == 1:
            print(f"{GREEN}[TIKTOK] Followed {tiktok_user_id} OK{RESET}")
            return True
        else:
            print(f"{YELLOW}[TIKTOK] Follow response: {json.dumps(data)[:200]}{RESET}")
            return False
    except Exception as e:
        print(f"{RED}[TIKTOK] Follow error: {e}{RESET}")
        return False


def tiktok_unfollow(tiktok_user_id):
    if not _SIGN_OK:
        return False

    url = f"{TIKTOK_API_BASE}/aweme/v1/commit/follow/user/"
    params = {
        "user_id": str(tiktok_user_id),
        "type": "0",
        "qid": "0",
        "aid": TIKTOK_AID,
        "device_id": str(_SIGN_DEVICE.device_id),
        "iid": str(_SIGN_DEVICE.iid),
        "install_id": str(_SIGN_DEVICE.install_id),
    }

    try:
        signed = sign_mobile_request(
            method="POST",
            path="/aweme/v1/commit/follow/user/",
            body={},
            device=_SIGN_DEVICE,
            params=params,
            return_headers=True,
        )

        headers = _build_tiktok_headers(signed, _SIGN_DEVICE)
        resp = requests.post(url, params=params, headers=headers, timeout=20)
        data = resp.json()
        
        status_code = data.get("status_code", -1)
        follow_status = data.get("follow_status", -1)
        
        if status_code == 0 or follow_status == 0:
            print(f"{GREEN}[TIKTOK] Unfollowed {tiktok_user_id} OK{RESET}")
            return True
        else:
            print(f"{YELLOW}[TIKTOK] Unfollow response: {json.dumps(data)[:200]}{RESET}")
            return False
    except Exception as e:
        print(f"{RED}[TIKTOK] Unfollow error: {e}{RESET}")
        return False
TIKSTAR_BASE = "https://api.tikstarapp.xyz/api/tikstar"
CLIENT_ID = "16"
CLIENT_SECRET = "3ZhY6sI2KhJ4iftS3IlFAypFT1m7dQMe1keSjTqF"
DEVICE_NUMBER = "d2e43f4b29eb2a86"
APP_VERSION = "22"
PLATFORM = "tiktok"

REGISTRATION_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxNiIsImp0aSI6IjMxYzZlOWFkZWE4ZjYxOGVhMTQzMTM1YWJhNDg4NmYyYmEzZjU5OTExNzkyYWM3ZGNlMmY2YWJjYzNmMzUxY2UxYzY4MTk4ZWY5ZTE2M2Q5IiwiaWF0IjoxNzYyMDYxODYwLjE1MzE4MywibmJmIjoxNzYyMDYxODYwLjE1MzE4NSwiZXhwIjoyMDc3NTk0NjYwLjE0OTQ4Niwic3ViIjoiIiwic2NvcGVzIjpbIioiXX0.XB7kc0sHW34lcIhvrDvFdWgyJK03lUzTegpv0FJMGN1RVD1HNCoJvOoBsoxLwu16LQaEZonfD2qcAW9oHhEbdMBHRDFtkFM1vszd0xB5crHpXJ526NSJ_xATelTJtomrs-UhRFov_rUD1ZDPWFrp9yger8QwsPYxEUogVlBcuxC23-I71un7Km5kPHglJ_exsPNPJOy1rxw_eQu774T0qGUHWM6LW-pQni3nOcfp3AZ6C-2XTorFMpj64f8nxIVb0gW20QDxUQ9f15qbaxeX85Xa67EHE1gpWt7gKQPhs7TRmbThZs4XmW3DKAv-0A8_0azoLX_s4xMhG9Ul2A-_1Fj_yVCVQkaIhzJkXHqKP-L7lDUNF4oBVNgKUKILzdWRq-IeefYzpocsd_rEiwB4ZeYCiEYdMFHHcKZt5Sf4Zjvl25uhjXzLEhbjjGlDx0jBOuPo4EHBccGtn1EvfAJSYkStCXQ-z7Bko4362G6hqdnFTp-YVjz8IpbzP_gA5UsUhRrAdgjRi6GEbdQWs2LTJKadpfq592MF_Umcg1MpSCt-vSQi7q2JKwZxBINT-p6APJckkQ_9Dmo2wZbtb2UwQoZP_Fh4YtI2ZGocrcR2OZojhY1nmhVPAe4hlPUZmEVQKX2SSA-_ADp07-gM30Zhy0bUFpJqxlKipYzLBoL92BM"

def gen_device_number():
    return ''.join(random.choices('0123456789abcdef', k=16))

_current_device = gen_device_number()

def get_base_headers():
    return {
        "User-Agent": "okhttp/4.12.0",
        "Accept-Encoding": "gzip",
        "device-number": _current_device,
        "platform": PLATFORM,
        "app-version": APP_VERSION,
        "accept-language": "en",
    }

def set_device_number(dev):
    global _current_device
    _current_device = dev

def get_auth_headers(token=None):
    headers = get_base_headers()
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers

def get_fid_from_username(username, registration_token=None):
    if not registration_token:
        registration_token = REGISTRATION_TOKEN
    
    url = f"{TIKSTAR_BASE}/users/tiktok/{username}"
    params = {"include": "account"}
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }
    
    print(f"[FID] Looking up TikTok FID for username: {username}...")
    for attempt in range(1, 5):
        headers = get_auth_headers(registration_token)
        try:
            resp = requests.post(url, params=params, data=payload, headers=headers, timeout=20)
            if resp.status_code in (200, 201):
                data = resp.json()
                fid = data.get("fid") or data.get("b")
                name = data.get("name") or data.get("c")
                user_id = data.get("id") or data.get("a")
                print(f"{GREEN}[FID] OK — fid={fid}, name={name}, tikstar_id={user_id}{RESET}")
                return fid, user_id, data
            elif resp.status_code == 403:
                new_dev = gen_device_number()
                set_device_number(new_dev)
                time.sleep(2)
                continue
            else:
                print(f"{RED}[FID] FAILED: {resp.status_code} {resp.text[:300]}{RESET}")
                return None, None, None
        except Exception as e:
            print(f"{RED}[FID] Error: {e}{RESET}")
            if attempt < 3:
                time.sleep(3)
    return None, None, None

def login_with_tiktok_fid(tiktok_fid, registration_token=None):
    if not registration_token:
        registration_token = REGISTRATION_TOKEN
    
    url = f"{TIKSTAR_BASE}/auth"
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "*",
        "username": str(tiktok_fid),
        "password": "password",
        "grant_type": "password",
    }
    headers = get_auth_headers(registration_token)

    print(f"[LOGIN] Logging in with TikTok FID: {tiktok_fid}...")
    for attempt in range(1, 4):
        try:
            resp = requests.post(url, data=payload, headers=headers, timeout=20)
            data = resp.json()

            if "access_token" in data:
                user_token = data["access_token"]
                try:
                    payload_b64 = user_token.split(".")[1]
                    payload_b64 += "=" * (4 - len(payload_b64) % 4)
                    jwt_payload = json.loads(base64.b64decode(payload_b64))
                    user_id = jwt_payload.get("sub", "?")
                    print(f"{GREEN}[LOGIN] OK — User ID: {user_id}{RESET}")
                    return user_token, user_id
                except:
                    print(f"{GREEN}[LOGIN] OK — token received{RESET}")
                    return user_token, None
            else:
                print(f"{RED}[LOGIN] Failed: {json.dumps(data, indent=2)[:500]}{RESET}")
                return None, None
        except Exception as e:
            print(f"{RED}[LOGIN] Error: {e}{RESET}")
            if attempt < 3:
                time.sleep(3)
    return None, None

def get_random_video(user_token, user_id):
    url = f"{TIKSTAR_BASE}/videos/rand"
    params = {"user_id": str(user_id)}
    headers = get_auth_headers(user_token)

    print(f"[VIDEO] Getting random video...", end=" ")
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            post_id = data.get("id")
            link = data.get("link", "")
            meta = data.get("meta", {})
            coins = meta.get("coins", "?")
            wait_seconds = meta.get("required_view_seconds", 2) 

            print(f"{GREEN}OK (id={post_id}, coins={coins}){RESET}")
            return {
                "id": post_id,
                "link": link,
                "coins": coins,
                "wait_seconds": 2,
            }
        else:
            print(f"{RED}FAILED: {resp.status_code}{RESET}")
            return None
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")
        return None

def submit_video_view(user_token, post_id):
    url = f"{TIKSTAR_BASE}/viewvideos"
    payload = {"post_id": str(post_id)}
    headers = get_auth_headers(user_token)

    print(f"[SUBMIT] Submitting view for post_id={post_id}...", end=" ")
    try:
        resp = requests.post(url, data=payload, headers=headers, timeout=15)
        if resp.status_code in (200, 201):
            data = resp.json()
            amount = data.get("amount", {})
            coins = amount.get("amount", "?")
            print(f"{GREEN}OK — Coins: {coins}{RESET}")
            return True, coins, None
        else:
            try:
                err_data = resp.json()
                err_code = err_data.get("code") or err_data.get("status_code") or resp.status_code
                err_msg = err_data.get("message", "")
            except:
                err_code = resp.status_code
                err_msg = resp.text[:200]
            print(f"{RED}FAILED: {resp.status_code} {err_msg}{RESET}")
            return False, None, err_code
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")
        return False, None, None

def get_user_coins(user_token):
    url = f"{TIKSTAR_BASE}/user"
    params = {"include": "account"}
    headers = get_auth_headers(user_token)
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            account = data.get("account", {})
            amount = account.get("amount", {})
            coins = amount.get("amount", "?")
            name = data.get("name", "?")
            return coins, name
    except:
        pass
    return "?", "?"

def claim_checkin(user_token):
    url = f"{TIKSTAR_BASE}/check-in/rewards"
    headers = get_auth_headers(user_token)
    print(f"[CHECKIN] Claiming daily check-in...", end=" ")
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            print(f"{GREEN}OK{RESET}")
        else:
            print(f"{YELLOW}{resp.status_code}{RESET}")
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")

def get_random_post(user_token, user_id):
    url = f"{TIKSTAR_BASE}/posts/rand"
    params = {"user_id": str(user_id)}
    headers = get_auth_headers(user_token)
    print(f"[POST] Getting random post...", end=" ")
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=20)
        if resp.status_code == 200:
            data = resp.json()
            return {
                "id": data.get("id"),
                "fid": data.get("fid"),
                "coins": data.get("meta", {}).get("coins", "?"),
            }
        else:
            print(f"{RED}FAILED: {resp.status_code}{RESET}")
            return None
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")
        return None

def fetch_post(user_token, post_id):
    url = f"{TIKSTAR_BASE}/tiktok/posts/{post_id}/fetch"
    headers = get_auth_headers(user_token)
    try:
        requests.get(url, headers=headers, timeout=20)
        return True
    except:
        return False

def like_post(user_token, post_id):
    url = f"{TIKSTAR_BASE}/likeposts"
    payload = {"post_ids": str(post_id)}
    headers = get_auth_headers(user_token)
    print(f"[LIKE] Liking post {post_id}...", end=" ")
    try:
        resp = requests.post(url, data=payload, headers=headers, timeout=20)
        if resp.status_code in (200, 201):
            coins = resp.json().get("amount", {}).get("amount", "?")
            print(f"{GREEN}OK — Coins: {coins}{RESET}")
            return True, coins, None
        else:
            return False, None, resp.status_code
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")
        return False, None, None

def get_random_user(user_token, user_id):
    url = f"{TIKSTAR_BASE}/users/rand"
    params = {"user_id": str(user_id)}
    headers = get_auth_headers(user_token)
    print(f"[USER] Getting random user...", end=" ")
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=20)
        if resp.status_code == 200:
            data = resp.json()
            print(f"{GREEN}OK (id={data.get('id')}, name={data.get('name')}){RESET}")
            return {
                "id": data.get("id"),
                "name": data.get("name", "?"),
                "fid": data.get("fid"),
            }
        else:
            print(f"{RED}FAILED: {resp.status_code}{RESET}")
            return None
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")
        return None

def visit_user_profile(user_token, username):
    url = f"{TIKSTAR_BASE}/users/tiktok/{username}"
    params = {"include": "account"}
    payload = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}
    headers = get_auth_headers(user_token)
    try:
        requests.post(url, params=params, data=payload, headers=headers, timeout=20)
        return True
    except:
        return False

def follow_user(user_token, user_id):
    url = f"{TIKSTAR_BASE}/tiktok/verify-follow"
    payload = {"user_id": str(user_id)}
    headers = get_auth_headers(user_token)
    print(f"[FOLLOW] Verifying follow for user {user_id}...", end=" ")
    try:
        resp = requests.post(url, data=payload, headers=headers, timeout=20)
        if resp.status_code in (200, 201):
            coins = resp.json().get("amount", {}).get("amount", "?")
            print(f"{GREEN}OK — Coins: {coins}{RESET}")
            return True, coins, None
        else:
            print(f"{RED}FAILED: {resp.status_code}{RESET}")
            return False, None, resp.status_code
    except Exception as e:
        print(f"{RED}ERROR: {e}{RESET}")
        return False, None, None

def main():
    print("=" * 60)
    print("  TikStar Video Bot FULL")
    print("=" * 60)

    username = input("[?] TikTok username: ").strip().replace("@", "")
    if not username:
        print("[!] لم يتم إدخال اسم مستخدم. خروج.")
        return

    count = 999999
    delay = 8 # تم تعديل الوقت إلى ثانيتين هنا
    
    print(f"\n[*] الإعدادات: delay={delay} ثانية")
    
    fid, tikstar_id, _ = get_fid_from_username(username)
    if not fid:
        return
    
    user_token, user_id = login_with_tiktok_fid(fid)
    if not user_token:
        return

    if not user_id:
        user_id = "2642027"

    coins, name = get_user_coins(user_token)
    print(f"\n[USER] Name: {name} | Coins: {coins}")

    claim_checkin(user_token)

    print(f"\n{GREEN}[*] بدء التشغيل تلقائي — VIDEO → LIKE → FOLLOW{RESET}")
    
    success_count = 0
    fail_count = 0
    total_earned = 0
    mode = "video"

    try:
        i = 0
        while i < count:
            i += 1
            print(f"\n{'─' * 50}")
            print(f"  #{i}  [{mode.upper()}]")
            print(f"{'─' * 50}")

            if mode == "video":
                video = get_random_video(user_token, user_id)
                if not video:
                    fail_count += 1
                    time.sleep(delay)
                    continue

                time.sleep(delay) 
                success, coins_earned, err_code = submit_video_view(user_token, video["id"])

                if success:
                    success_count += 1
                    total_earned += int(coins_earned) if coins_earned != "?" else 0
                else:
                    fail_count += 1
                    if err_code in (409021, 409):
                        mode = "like"
                        continue

            elif mode == "like":
                post = get_random_post(user_token, user_id)
                if not post:
                    fail_count += 1
                    time.sleep(delay)
                    continue

                fetch_post(user_token, post["id"])
                time.sleep(delay)

                success, coins_earned, err_code = like_post(user_token, post["id"])
                if success:
                    success_count += 1
                    total_earned += int(coins_earned) if coins_earned != "?" else 0
                else:
                    fail_count += 1
                    if err_code and err_code >= 400:
                        mode = "follow"
                        continue

            elif mode == "follow":
                target = get_random_user(user_token, user_id)
                if not target:
                    fail_count += 1
                    time.sleep(delay)
                    continue

                if target.get("name") and target.get("name") != "?":
                    visit_user_profile(user_token, target.get("name"))
                time.sleep(delay)

                if target.get("fid"):
                    follow_ok = tiktok_follow(target.get("fid"))
                    if not follow_ok:
                        fail_count += 1
                        time.sleep(delay)
                        continue

                time.sleep(2)
                success, coins_earned, err_code = follow_user(user_token, target.get("id"))

                if target.get("fid"):
                    time.sleep(1)
                    tiktok_unfollow(target.get("fid"))

                if success:
                    success_count += 1
                    total_earned += int(coins_earned) if coins_earned != "?" else 0
                else:
                    fail_count += 1

            time.sleep(delay)
    except KeyboardInterrupt:
        print(f"\n{YELLOW}[!] تم الإيقاف يدوياً{RESET}")

    print(f"\n{'=' * 60}")
    print(f"  FINAL RESULTS")
    print(f"{'=' * 60}")
    print(f"  Successful:     {success_count}")
    print(f"  Failed:         {fail_count}")
    print(f"  Total earned:   ~{total_earned} coins")

if __name__ == "__main__":
    main()
