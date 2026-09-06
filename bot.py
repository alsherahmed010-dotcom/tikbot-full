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
    
    print(f"Getting FID for {username}...")
    print(f"URL: {url}")
    
    try:
        resp = requests.post(url, params={"include": "account"}, data=payload, headers=headers, timeout=20)
        print(f"Status: {resp.status_code}")
        print(f"Response: {resp.text[:300]}")
        
        if resp.status_code == 200:
            data = resp.json()
            return data.get("fid"), data.get("id")
    except Exception as e:
        print(f"Error: {e}")
    
    return None, None

def main():
    username = sys.argv[1] if len(sys.argv) > 1 else input("Username: ")
    username = username.replace("@", "").strip()
    
    print(f"Testing FID lookup for: {username}")
    fid, user_id = get_fid(username)
    
    if fid:
        print(f"✅ FID: {fid}")
        print(f"✅ User ID: {user_id}")
    else:
        print("❌ Failed")

if __name__ == "__main__":
    main()
