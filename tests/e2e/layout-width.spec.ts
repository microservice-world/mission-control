import { test, expect } from '@playwright/test';

test('Alert Rules panel should be full width', async ({ page }) => {
  // Login
  await page.goto('http://localhost:3005/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'Informatica1!');
  await page.click('button[type="submit"]');
  await page.waitForURL('http://localhost:3005/');

  // Navigate to Alerts
  await page.goto('http://localhost:3005/alerts');
  await page.waitForSelector('h2:has-text("Alert Rules")');

  // Check the width of the main container
  const container = page.locator('main#main-content > div > div > div').first();
  const box = await container.boundingBox();
  const mainBox = await page.locator('main#main-content').boundingBox();

  console.log(`Container width: ${box?.width}`);
  console.log(`Main Content width: ${mainBox?.width}`);

  // It should be close to the main content width (minus padding)
  if (box && mainBox) {
    expect(box.width).toBeGreaterThan(mainBox.width * 0.8);
  }
});
