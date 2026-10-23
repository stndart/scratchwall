FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir -r requirements.txt
COPY engine.py worker.py ./
ENV HF_HOME=/models HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
EXPOSE 8090
CMD ["python", "worker.py"]
