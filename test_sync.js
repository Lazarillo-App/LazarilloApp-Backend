const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiIxIiwiZW1haWwiOiJtYWlyZW5ldmlsbGFzbWlsZkBnbWFpbC5jb20iLCJpYXQiOjE3NTc1MTA4OTksImV4cCI6MTc1ODExNTY5OX0.AkaGC5MpKUOcC_wx7q42KxINbpipUeyfZ1r6OVI7Tls'; // pega el token
(async () => {
  const r = await fetch('https://lazarilloapp-backend.onrender.com/api/businesses/7/sync', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ scope: 'sales', from: '2025-08-01', to: '2025-09-04' })
  });
  console.log(r.status, r.headers.get('content-type'));
  const txt = await r.text();
  console.log(txt.slice(0, 300));
})();
