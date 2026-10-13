curl http://localhost:3000/api/send \
  -F chat_ids=5064323191,-5441480508 \
  -F "message=High CPU on node-1" \
  -F files=@files/sample.png \
  -F files=@files/test.log
