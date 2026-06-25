import sys
import os
import argparse
import json
import sqlite3

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

def get_dhash(image_path, hash_size=8):
    try:
        from PIL import Image
    except ImportError:
        return None, "Pillow library is not installed. Run 'pip install Pillow'"

    try:
        if not os.path.exists(image_path):
            return None, f"File does not exist: {image_path}"
        
        # Open image, convert to grayscale and resize to (9, 8) for 8-bit hash
        img = Image.open(image_path).convert('L').resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
        pixels = list(img.getdata())
        
        difference = []
        for row in range(hash_size):
            for col in range(hash_size):
                pixel_left = pixels[row * (hash_size + 1) + col]
                pixel_right = pixels[row * (hash_size + 1) + col + 1]
                difference.append(pixel_left > pixel_right)
                
        # Convert list of booleans to hexadecimal representation
        decimal_value = 0
        hex_string = []
        for index, value in enumerate(difference):
            if value:
                decimal_value += 2**(index % 8)
            if (index % 8) == 7:
                hex_string.append(hex(decimal_value)[2:].zfill(2))
                decimal_value = 0
        return "".join(hex_string), None
    except Exception as e:
        return None, str(e)

def get_gps_coordinates(image_path):
    try:
        from PIL import Image
        from PIL.ExifTags import TAGS, GPSTAGS
    except ImportError:
        return None, None, "Pillow library is not installed."

    try:
        if not os.path.exists(image_path):
            return None, None, f"File does not exist: {image_path}"
        
        img = Image.open(image_path)
        
        gps_info = {}
        # Try using img.getexif() sub-IFD 34853 (works for DNG/TIFF and JPEGs)
        try:
            exif = img.getexif()
            if exif:
                ifd_gps = exif.get_ifd(34853)
                if ifd_gps:
                    for t, val in ifd_gps.items():
                        sub_decoded = GPSTAGS.get(t, t)
                        gps_info[sub_decoded] = val
        except Exception:
            pass
            
        # Fallback to _getexif() if getexif() did not yield GPS tags
        if not gps_info:
            try:
                exif = img._getexif()
                if exif:
                    for key, value in exif.items():
                        decoded = TAGS.get(key, key)
                        if decoded == "GPSInfo":
                            for t in value:
                                sub_decoded = GPSTAGS.get(t, t)
                                gps_info[sub_decoded] = value[t]
            except Exception:
                pass
                
        if not gps_info:
            return None, None, "No GPS tags found."
            
        gps_lat = gps_info.get("GPSLatitude")
        gps_lng = gps_info.get("GPSLongitude")
        if not gps_lat or not gps_lng:
            return None, None, "Missing GPS coordinates."
            
        def convert_to_degrees(value):
            d = float(value[0])
            m = float(value[1])
            s = float(value[2])
            return d + (m / 60.0) + (s / 3600.0)

        lat = convert_to_degrees(gps_lat)
        lat_ref = gps_info.get("GPSLatitudeRef")
        if isinstance(lat_ref, bytes):
            lat_ref = lat_ref.decode('utf-8', errors='ignore')
        if lat_ref:
            lat_ref = lat_ref.strip().upper()
        if not lat_ref:
            lat_ref = "N"
        if lat_ref != "N":
            lat = -lat
            
        lng = convert_to_degrees(gps_lng)
        lng_ref = gps_info.get("GPSLongitudeRef")
        if isinstance(lng_ref, bytes):
            lng_ref = lng_ref.decode('utf-8', errors='ignore')
        if lng_ref:
            lng_ref = lng_ref.strip().upper()
        if not lng_ref:
            lng_ref = "E"
        if lng_ref != "E":
            lng = -lng
            
        return lat, lng, None
    except Exception as e:
        return None, None, str(e)

def reverse_geocode(lat, lng):
    import urllib.request
    import urllib.parse
    import time
    
    # Try combinations of signs if coordinates land in the ocean (Unknown Country).
    # This recovers locations when GPS latitude/longitude reference tags are missing.
    combinations = [
        (lat, lng),
        (lat, -lng),
        (-lat, lng),
        (-lat, -lng)
    ]
    
    last_err = None
    for i, (test_lat, test_lng) in enumerate(combinations):
        try:
            url = f"https://nominatim.openstreetmap.org/reverse?lat={test_lat}&lon={test_lng}&format=json&accept-language=en"
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
            )
            with urllib.request.urlopen(req, timeout=3) as response:
                data = json.loads(response.read().decode('utf-8'))
                address = data.get("address", {})
                city = address.get("city") or address.get("town") or address.get("village") or address.get("suburb") or "Unknown City"
                country = address.get("country") or "Unknown Country"
                if country and country != "Unknown Country":
                    return country, city, test_lat, test_lng, None
        except Exception as e:
            last_err = f"Geocoding request failed: {str(e)}"
            
        # Add a delay if we are about to try the next combination
        if i < len(combinations) - 1:
            time.sleep(0.5)
            
    # Default fallback to the original coordinates if no valid land location was found
    return "Unknown Country", "Unknown City", lat, lng, last_err

def get_mp4_gps(file_path):
    try:
        import os
        import re
        
        file_size = os.path.getsize(file_path)
        coord_regex = re.compile(rb'([+-]\d+\.\d+)([+-]\d+\.\d+)(?:[+-]\d+\.\d+)?/')
        
        # Read first 10MB
        with open(file_path, 'rb') as f:
            head = f.read(10 * 1024 * 1024)
            match = coord_regex.search(head)
            if match:
                lat = float(match.group(1))
                lng = float(match.group(2))
                if lng > 180.0:
                    lng -= 360.0
                elif lng < -180.0:
                    lng += 360.0
                return lat, lng, None
                
        # Read last 10MB if file is larger than 10MB
        if file_size > 10 * 1024 * 1024:
            with open(file_path, 'rb') as f:
                f.seek(file_size - 10 * 1024 * 1024)
                tail = f.read(10 * 1024 * 1024)
                match = coord_regex.search(tail)
                if match:
                    lat = float(match.group(1))
                    lng = float(match.group(2))
                    if lng > 180.0:
                        lng -= 360.0
                    elif lng < -180.0:
                        lng += 360.0
                    return lat, lng, None
                    
        return None, None, "No location coordinates found in video container."
    except Exception as e:
        return None, None, str(e)

def hamming_distance(hex1, hex2):
    # Convert hex string to integer, then XOR, then count 1 bits
    val1 = int(hex1, 16)
    val2 = int(hex2, 16)
    xor_val = val1 ^ val2
    # Count set bits
    return bin(xor_val).count('1')

def init_db(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sorted_media (
            file_path TEXT PRIMARY KEY,
            dhash_hex TEXT,
            date_taken TEXT
        )
    ''')
    conn.commit()
    conn.close()

def main():
    parser = argparse.ArgumentParser(description="Local Visual Similarity Twin-Matching Engine")
    parser.add_argument("--index", help="Index a photo file path")
    parser.add_argument("--query", help="Query a photo file path for visual matches")
    parser.add_argument("--gps", help="Extract GPS metadata and reverse geocode a photo file path")
    parser.add_argument("--db", help="Path to sqlite vectors database")
    parser.add_argument("--date", help="Date taken of the file (required for index)")
    parser.add_argument("--threshold", type=float, default=0.85, help="Similarity threshold (0.0 to 1.0)")
    
    args = parser.parse_args()

    if args.gps:
        if "," in args.gps:
            try:
                lat_str, lng_str = args.gps.split(",")
                lat = float(lat_str)
                lng = float(lng_str)
                err = None
            except Exception as e:
                lat, lng, err = None, None, str(e)
        else:
            ext = os.path.splitext(args.gps)[1].lower()
            if ext == ".mp4" or ext == ".mov":
                lat, lng, err = get_mp4_gps(args.gps)
            else:
                lat, lng, err = get_gps_coordinates(args.gps)
        if err:
            print(json.dumps({"success": True, "country": None, "city": None, "info": err}))
            return
            
        country, city, resolved_lat, resolved_lng, geo_err = reverse_geocode(lat, lng)
        if geo_err and country == "Unknown Country":
            print(json.dumps({"success": True, "country": None, "city": None, "info": geo_err}))
            return
            
        print(json.dumps({"success": True, "country": country, "city": city, "lat": resolved_lat, "lng": resolved_lng}))
        return

    # Check db path requirement for database operations
    if not args.db:
        print(json.dumps({"success": False, "error": "Parameter --db is required for index or query operations"}))
        return

    try:
        init_db(args.db)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to initialize database: {str(e)}"}))
        return

    if args.index:
        if not args.date:
            print(json.dumps({"success": False, "error": "Parameter --date is required for indexing"}))
            return
            
        dhash, err = get_dhash(args.index)
        if err:
            print(json.dumps({"success": False, "error": err}))
            return
            
        try:
            conn = sqlite3.connect(args.db)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT OR REPLACE INTO sorted_media (file_path, dhash_hex, date_taken) VALUES (?, ?, ?)",
                (args.index, dhash, args.date)
            )
            conn.commit()
            conn.close()
            print(json.dumps({"success": True, "indexed": args.index, "dhash": dhash}))
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Database write error: {str(e)}"}))
            
    elif args.query:
        dhash, err = get_dhash(args.query)
        if err:
            print(json.dumps({"success": False, "error": err}))
            return
            
        try:
            conn = sqlite3.connect(args.db)
            cursor = conn.cursor()
            cursor.execute("SELECT file_path, dhash_hex, date_taken FROM sorted_media")
            rows = cursor.fetchall()
            conn.close()
            
            best_match = None
            best_similarity = 0.0
            
            import re
            def get_clean_basename_py(filepath):
                filename = os.path.basename(filepath)
                base = filename[:-5] if filename.lower().endswith(".json") else filename
                base, _ = os.path.splitext(base)
                base = re.sub(r'^copy\s+of\s+', '', base, flags=re.IGNORECASE)
                base = re.sub(r'(?:-\d{1,3}|\(\d{1,3}\)|_\d{1,3}|_edited|-edited)(?:-\d{1,3})?$', '', base, flags=re.IGNORECASE)
                return base.strip().lower()

            query_clean_base = get_clean_basename_py(args.query)
            
            # 1. Try filename clean base match first
            for file_path, db_dhash, date_taken in rows:
                if get_clean_basename_py(file_path) == query_clean_base:
                    best_match = {
                        "file_path": file_path,
                        "similarity": 1.0,
                        "date_taken": date_taken
                    }
                    break
            
            # 2. Fallback to dhash visual similarity if no filename twin match found
            if not best_match:
                for file_path, db_dhash, date_taken in rows:
                    dist = hamming_distance(dhash, db_dhash)
                    # similarity scale: 0 bits difference = 1.0, 64 bits difference = 0.0
                    similarity = 1.0 - (dist / 64.0)
                    
                    if similarity >= args.threshold and similarity > best_similarity:
                        best_similarity = similarity
                        best_match = {
                            "file_path": file_path,
                            "similarity": round(similarity, 4),
                            "date_taken": date_taken
                        }
                        
            if best_match:
                print(json.dumps({"success": True, "match": best_match}))
            else:
                print(json.dumps({"success": True, "match": None}))
                
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Database query error: {str(e)}"}))
    else:
        print(json.dumps({"success": False, "error": "Either --index, --query, or --gps parameter must be provided"}))

if __name__ == "__main__":
    main()
