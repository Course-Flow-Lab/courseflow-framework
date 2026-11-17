FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./server.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65534:65534
EXPOSE 8190
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8190"]
