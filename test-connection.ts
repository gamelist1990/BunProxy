import net from 'net';
import dgram from 'dgram';

const TARGET_HOST = 'localhost';
const TARGET_PORT_TCP = 25565;
const TARGET_PORT_UDP = 25565;

console.log('=== Testing TCP Connection ===');
const tcpClient = net.connect(TARGET_PORT_TCP, TARGET_HOST, () => {
  console.log(`✓ TCP Connected to ${TARGET_HOST}:${TARGET_PORT_TCP}`);
  
  // Send test data
  const testData = Buffer.from('Hello from TCP client');
  console.log(`Sending ${testData.length} bytes...`);
  tcpClient.write(testData);
  
  setTimeout(() => {
    console.log('Closing TCP connection');
    tcpClient.end();
  }, 2000);
});

tcpClient.on('data', (data) => {
  console.log(`✓ Received TCP response: ${data.length} bytes`);
});

tcpClient.on('error', (err) => {
  console.error(`✗ TCP Error: ${err.message}`);
});

tcpClient.on('close', () => {
  console.log('TCP connection closed\n');
  
  // Test UDP after TCP
  console.log('=== Testing UDP Connection ===');
  const udpClient = dgram.createSocket('udp4');
  
  const testData = Buffer.from('Hello from UDP client');
  console.log(`Sending ${testData.length} bytes to ${TARGET_HOST}:${TARGET_PORT_UDP}...`);
  
  udpClient.send(testData, TARGET_PORT_UDP, TARGET_HOST, (err) => {
    if (err) {
      console.error(`✗ UDP Send Error: ${err.message}`);
      udpClient.close();
      return;
    }
    console.log('✓ UDP packet sent');
  });
  
  udpClient.on('message', (msg, rinfo) => {
    console.log(`✓ Received UDP response from ${rinfo.address}:${rinfo.port}: ${msg.length} bytes`);
    udpClient.close();
  });
  
  udpClient.on('error', (err) => {
    console.error(`✗ UDP Error: ${err.message}`);
    udpClient.close();
  });
  
  setTimeout(() => {
    console.log('UDP test timeout');
    udpClient.close();
  }, 3000);
});
