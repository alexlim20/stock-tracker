from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import modal

app = modal.App("gemma-4-12b-serverless")

# Configure virtual storage volume to download and cache Hugging Face model weights
volume = modal.Volume.from_name("gemma-4-cache", create_if_missing=True)

# Define python environment with necessary CUDA/deep learning dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers",
        "accelerate",
        "torch",
        "torchvision",
        "huggingface_hub[hf_transfer]",
        "pillow",
        "fastapi"
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"}) # Fast Hugging Face downloads
)

@app.cls(
    image=image,
    gpu="L4", # NVIDIA L4 GPU instance
    cpu=8.0,
    memory=32768,
    volumes={"/root/.cache/huggingface": volume}, # Mount cache volume
    scaledown_window=2, # Zero-linger scale down (2 seconds)
    max_containers=1, # Strict Serial Execution (autoscale concurrency cap of 1)
    timeout=60, # Execution Timeout Kill-Switch (60 seconds)
    startup_timeout=600, # Allow up to 10 minutes for model weights download/caching
    secrets=[modal.Secret.from_name("huggingface-secret")] # HF gated model token secret
)
class GemmaModel:
    @modal.enter()
    def load_model(self):
        import torch
        from transformers import AutoProcessor, AutoModelForCausalLM
        
        self.model_id = "google/gemma-4-12b-it"
        print(f"Loading processor and model weights for {self.model_id} from HuggingFace...")
        
        # Load processor
        self.processor = AutoProcessor.from_pretrained(self.model_id)
        
        # Load model using bfloat16 for efficiency on L4 GPU
        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            device_map="auto"
        )
        print("Model loaded successfully!")

    @modal.fastapi_endpoint(method="POST")
    async def verify_asset(self, request: Request):
        import base64
        import io
        import json
        from PIL import Image
        import torch
        
        try:
            body = await request.json()
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": f"Invalid JSON body: {str(e)}"})

        messages = body.get("messages", [])
        if not messages:
            return JSONResponse(status_code=400, content={"error": "Missing messages list"})

        system_prompt = ""
        user_prompt = ""
        base64_image = None

        # Parse messages compatible with OpenAI structure or Ollama's direct images array
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content")
            if role == "system":
                system_prompt = content
            elif role == "user":
                if isinstance(content, list):
                    for part in content:
                        if part.get("type") == "text":
                            user_prompt = part.get("text")
                        elif part.get("type") == "image_url":
                            image_url = part.get("image_url", {}).get("url", "")
                            if image_url.startswith("data:image"):
                                base64_image = image_url.split(",")[1 if "," in image_url else 0]
                else:
                    user_prompt = content
                
                if "images" in msg and isinstance(msg["images"], list) and len(msg["images"]) > 0:
                    base64_image = msg["images"][0]

        # Extract image if base64 data is attached
        image = None
        if base64_image:
            try:
                # Remove data URL scheme prefix if present
                if "," in base64_image:
                    base64_image = base64_image.split(",")[1]
                image_bytes = base64.b64decode(base64_image)
                image = Image.open(io.BytesIO(image_bytes))
            except Exception as e:
                return JSONResponse(status_code=400, content={"error": f"Failed to parse image: {str(e)}"})

        # Format chat history matching model's expected template
        chat = []
        if system_prompt:
            chat.append({"role": "system", "content": system_prompt})
        
        user_content = []
        if image:
            user_content.append({"type": "image"})
        user_content.append({"type": "text", "text": user_prompt})
        chat.append({"role": "user", "content": user_content})

        try:
            prompt = self.processor.apply_chat_template(chat, add_generation_prompt=True)
            inputs = self.processor(text=prompt, images=image, return_tensors="pt").to("cuda")
            
            # Limit generation parameters (keep context budget low: max_new_tokens is short)
            with torch.inference_mode():
                outputs = self.model.generate(
                    **inputs,
                    max_new_tokens=256,
                    temperature=0.1,
                    do_sample=False
                )
            
            generated_ids = outputs[0][inputs["input_ids"].shape[1]:]
            response_text = self.processor.decode(generated_ids, skip_special_tokens=True).strip()
            
            # Clean model output to isolate the JSON block
            try:
                ai_result = json.loads(response_text)
                return JSONResponse(content={
                    "message": {
                        "role": "assistant",
                        "content": json.dumps(ai_result)
                    }
                })
            except Exception:
                start = response_text.find("{")
                end = response_text.rfind("}")
                if start != -1 and end != -1 and end > start:
                    json_str = response_text[start:end+1]
                    ai_result = json.loads(json_str)
                    return JSONResponse(content={
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(ai_result)
                        }
                    })
                
                # Fallback if model output is not formatted as JSON
                fallback_result = {
                    "isValidMedia": True,
                    "parsedDate": "N/A",
                    "suggestedSubFolder": "Media",
                    "raw": response_text
                }
                return JSONResponse(content={
                    "message": {
                        "role": "assistant",
                        "content": json.dumps(fallback_result)
                    }
                })
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"Inference failed: {str(e)}"})
