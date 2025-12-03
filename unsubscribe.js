const { chromium } = require('playwright');

// === CONFIGURATION ===
// Delays are crucial to avoid race conditions and rate limits.
const DELAY_MS = 500; 
const STABILIZATION_DELAY_MS = 10000; // 10 seconds to ensure channel element is removed.
// =====================

/**
 * Sleeps for a given duration.
 * @param {number} ms The time to wait in milliseconds.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Automates the login process for a standard Google account.
 * @param {import('playwright').Page} page
 */
async function login(page) {
    console.log("Navigating to YouTube and attempting login...");
    await page.goto('https://www.youtube.com');
    
    // Check for sign-in button
    const signInButtonSelector = 'ytd-masthead button[aria-label="Sign in"]';
    const signInButton = await page.locator(signInButtonSelector);

    if (await signInButton.isVisible()) {
        await signInButton.click();

        // 1. Enter Email
        await page.waitForSelector('input[type="email"]');
        await page.fill('input[type="email"]', process.env.YT_EMAIL);
        await page.keyboard.press('Enter');

        // 2. Enter Password
        await page.waitForSelector('input[type="password"]');
        await page.fill('input[type="password"]', process.env.YT_PASSWORD);
        await page.keyboard.press('Enter');
        
        // Wait for YouTube homepage to load (using a common selector)
        await page.waitForSelector('#guide-content', { timeout: 15000 });
        console.log("Login successful.");
    } else {
        console.log("Already logged in or login button not found. Proceeding.");
    }
}

/**
 * Automatically scrolls the page down until all channels are loaded.
 * @param {import('playwright').Page} page
 */
async function preloadAllChannels(page) {
    console.log("--- Phase 1: Pre-loading all channels via scrolling... ---");
    let previousCount = 0;
    
    // Navigate directly to the subscriptions page
    await page.goto('https://www.youtube.com/feed/channels', { waitUntil: 'domcontentloaded' });

    while (true) {
        // Evaluate in the browser context to get the current count
        const currentCount = await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            // Count all visible channel rows
            return document.querySelectorAll('ytd-channel-renderer:not([hidden])').length;
        });

        await sleep(3000); // Give time for new channels to load after scroll

        if (currentCount === previousCount) {
            console.log(`Scrolling stopped: Reached the end with ${currentCount} channels loaded.`);
            break;
        }
        
        console.log(`Channels loaded so far: ${currentCount}`);
        previousCount = currentCount;
    }
    console.log("--- Pre-loading Complete. Proceeding to delete phase. ---");
}

/**
 * Finds all visible "Subscribed" buttons and clicks them sequentially.
 * @param {import('playwright').Page} page
 */
async function bulkUnsubscribe(page) {
    await preloadAllChannels(page);
    
    console.log("--- Phase 2: Starting Bulk Unsubscribe (List Iteration Method) ---");
    
    // Selector for ALL INITIAL buttons (Subscribed). We gather them all at the start.
    const PRIMARY_BUTTON_SELECTOR = 'ytd-channel-renderer:not([hidden]) ytd-subscribe-button-renderer button.yt-spec-button-shape-next';
    const CONFIRM_BUTTON_SELECTOR = 'ytd-popup-container button[aria-label="Unsubscribe"].yt-spec-button-shape-next--call-to-action';

    // Capture the static list of all buttons now that the page is fully loaded.
    const allButtons = await page.locator(PRIMARY_BUTTON_SELECTOR).all();
    console.log(page);
    if (allButtons.length === 0) {
        console.log("No 'Subscribed' buttons found. Check login or ensure subscriptions exist.");
        return;
    }
    
    console.log(`Found ${allButtons.length} total channels to process.`);

    let deletedCount = 0;

    console.log(allButtons);
    // Loop through the fixed list of buttons
    for (const [index, subscribeButtonElement] of allButtons.entries()) {
        const itemNumber = index + 1;
        
        try {
            // Check if the element is visible and has "Subscribed" text (Playwright's equivalent of our JS check)
            const buttonText = await subscribeButtonElement.textContent();
            if (buttonText.trim().toLowerCase() !== 'subscribed') {
                 console.log(`[${itemNumber}/${allButtons.length}] Skipping: Already unsubscribed or button text is unexpected.`);
                 continue; 
            }

            // --- Click 1: The "Subscribed" Button ---
            console.log(`[${itemNumber}/${allButtons.length}] Clicking Subscription Button...`);
            await subscribeButtonElement.click({ timeout: 5000 });
            
            // Wait for the confirmation menu/dialog to appear
            await sleep(DELAY_MS); 

            // --- Click 2: The "Unsubscribe" Menu Item ---
            // Use Playwright to locate the element by text content in the menu
            const unsubscribeMenuItem = page.locator('tp-yt-paper-listbox ytd-menu-service-item-renderer', { hasText: /Unsubscribe/i });
            
            if (await unsubscribeMenuItem.isVisible()) {
                await unsubscribeMenuItem.click();
                console.log(`[${itemNumber}/${allButtons.length}] Selected 'Unsubscribe' from the menu.`);
                
                // Wait for the final confirmation dialog to appear
                await sleep(DELAY_MS); 

                // --- Click 3: The Final Confirmation Button ---
                const confirmButton = page.locator(CONFIRM_BUTTON_SELECTOR);
                
                if (await confirmButton.isVisible()) {
                    await confirmButton.click();
                    console.log(`[${itemNumber}/${allButtons.length}] Confirmed final unsubscription.`);
                    deletedCount++;
                    
                    // CRITICAL FIX: Wait 10 seconds for the channel row to disappear.
                    console.log(`Waiting ${STABILIZATION_DELAY_MS / 1000} seconds for UI stabilization...`);
                    await sleep(STABILIZATION_DELAY_MS); 
                } else {
                    console.warn(`[${itemNumber}/${allButtons.length}] WARNING: Confirmation button not found! Skipping.`);
                    await sleep(STABILIZATION_DELAY_MS); 
                }
            } else {
                console.warn(`[${itemNumber}/${allButtons.length}] Warning: Did not find the 'Unsubscribe' menu item. Skipping.`);
                await sleep(DELAY_MS * 3);
            }
            
        } catch (error) {
            console.error(`An error occurred while processing subscription ${itemNumber}:`, error);
            await sleep(STABILIZATION_DELAY_MS); 
        }
    }

    console.log(`\n--- Script Finished ---`);
    console.log(`Total channels deleted: ${deletedCount}`);
}


(async () => {
    let browser;
    try {
        if (!process.env.YT_EMAIL || !process.env.YT_PASSWORD) {
            throw new Error("Missing YT_EMAIL or YT_PASSWORD environment variable. Check your GitHub Secrets configuration.");
        }
        
        // Launch a headless Chromium browser
        browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        
        await login(page);
        await bulkUnsubscribe(page);

    } catch (error) {
        console.error("Fatal Error in Automation:", error.message);
        process.exit(1); // Exit with error code
    } finally {
        if (browser) {
            await browser.close();
        }
    }
})();
