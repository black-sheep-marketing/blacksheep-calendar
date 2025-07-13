// server.js - Main backend server for Render
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Google Calendar Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// In-memory storage (use a database like PostgreSQL in production)
let bookings = [];

// Configuration
const CONFIG = {
    CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID,
    SHOPIFY_STORE_URL: process.env.SHOPIFY_STORE_URL,
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN,
    WORKING_HOURS: { start: 9, end: 17 },
    WORKING_DAYS: [1, 2, 3, 4, 5], // Monday to Friday
    MIN_BOOKING_HOURS: 1,
    WARMUP_MINUTES: 30,    // Buffer before meeting
    COOLDOWN_MINUTES: 30   // Buffer after meeting
};

// Email transporter
const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

// Helper function to format qualification data for calendar description
function formatQualificationData(qualificationData) {
    const fieldLabels = {
        website: 'Website/Store URL',
        role: 'Position/Role',
        channels: 'Current Advertising Channels',
        revenue_goal: 'Monthly Revenue Goal (6-12 months)',
        ad_management: 'Who Manages Ad Accounts',
        current_revenue: 'Current Monthly DTC Revenue',
        funding: 'Funding Status',
        ad_spend: 'Ad Spend (Past 30 Days)',
        problems: 'Current Problems/Challenges'
    };

    const valueLabels = {
        // Role values
        'brand-owner': 'Brand Owner/Founder/CEO',
        'in-house-marketer': 'In-House Brand Marketer/Operator',
        'agency-consultant': 'Agency/Consultant/Investor',
        'other': 'Other',
        
        // Channel values
        'meta': 'Meta (Facebook and/or Instagram)',
        'google': 'Google',
        'tiktok': 'TikTok',
        'combination': 'Combination of multiple channels',
        
        // Revenue goal values
        '20k-50k': '$20,000-$50,000/month',
        '51k-200k': '$51,000-$200,000/month',
        '201k-500k': '$201,000-$500,000/month',
        '501k-1m': '$501,000-$1,000,000/month',
        '1m+': '$1,000,000+/month',
        
        // Ad management values
        'in-house': 'We manage our paid advertising in-house',
        'freelancer': 'We work with a freelancer that runs all of our paid advertising',
        'agency': 'We work with an agency that runs all of our paid advertising',
        
        // Current revenue values
        'pre-revenue': 'Pre-revenue',
        '1-10k': '$1-$10K/month',
        '11-50k': '$11-$50k/month',
        '51-100k': '$51-$100k/month',
        '101-250k': '$101-$250K/month',
        '250k-1m': '$250k-$1M/month',
        '1m+': '$1M/month+',
        
        // Funding values
        'self-funded': 'Self-Funded',
        'seeking-investment': 'Currently Seeking External Investment',
        'secured-funding': 'Secured External Funding (VC, Private Equity, Angel Investors)',
        
        // Ad spend values
        '0': '$0',
        '1000-10000': '$1,000-$10,000',
        '11000-30000': '$11,000-$30,000',
        '31000-100000': '$31,000-$100,000',
        '101000-250000': '$101,000-$250,000',
        '251000+': '$251,000+',
        
        // Problems values
        'losing-money': 'Our ads are losing money and we can\'t hit our breakeven ROAS, PLEASE HELP',
        'not-hitting-target': 'We are profitable but we\'re not hitting our target ROAS and we just can\'t seem to get our existing advertising campaigns to convert better',
        'doing-well': 'We\'re doing well, but we want to be the best and we\'d love to optimize our advertising even further to maximize profitability',
        'getting-started': 'We\'re just getting started with paid ads and we\'re already overwhelmed by all of the conflicting advice from agencies and consultants'
    };

    let formattedData = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 PROSPECT QUALIFICATION DETAILS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    Object.entries(qualificationData).forEach(([key, value]) => {
        if (value && fieldLabels[key]) {
            const label = fieldLabels[key];
            const displayValue = valueLabels[value] || value;
            formattedData += `🔹 ${label}:\n   ${displayValue}\n\n`;
        }
    });

    return formattedData;
}

// API Routes

// Get availability for a specific month
app.get('/api/availability', async (req, res) => {
    try {
        const { year, month, timezone } = req.query;
        const startDate = new Date(year, month, 1);
        const endDate = new Date(year, parseInt(month) + 1, 0);
        
        console.log(`Fetching calendar events for ${CONFIG.CALENDAR_ID} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
        console.log(`Client timezone: ${timezone || 'not provided'}`);
        
        // Get existing events from Google Calendar
        const response = await calendar.events.list({
            calendarId: CONFIG.CALENDAR_ID,
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: true,
            orderBy: 'startTime'
        });

        const events = response.data.items || [];
        console.log(`Found ${events.length} existing events for ${year}-${month}`);
        const bookedSlots = new Set();

        // Process existing events
        events.forEach(event => {
            console.log('Processing event:', {
                summary: event.summary,
                start: event.start,
                end: event.end
            });

            let eventStart, eventEnd;

            // Handle both timed events and all-day events
            if (event.start && event.start.dateTime) {
                // Timed event - convert to client timezone
                eventStart = new Date(event.start.dateTime);
                eventEnd = new Date(event.end.dateTime);
                
                console.log(`Event "${event.summary}" original time: ${eventStart.toISOString()}`);
                
            } else if (event.start && event.start.date) {
                // All-day event
                eventStart = new Date(event.start.date + 'T00:00:00');
                eventEnd = new Date(event.end.date + 'T00:00:00');
                
                // Block entire day for all-day events
                for (let hour = CONFIG.WORKING_HOURS.start; hour < CONFIG.WORKING_HOURS.end; hour++) {
                    for (let minute of [0, 30]) {
                        const slotKey = `${eventStart.toDateString()}_${hour}_${minute}`;
                        bookedSlots.add(slotKey);
                        console.log('Blocking all-day slot:', slotKey);
                    }
                }
                return; // Skip the rest for all-day events
            } else {
                return; // Skip events without proper time data
            }

            // For timed events, block the specific time slots
            const clientTimezone = timezone || 'America/Phoenix';
            
            console.log(`Converting event "${event.summary}" to ${clientTimezone}`);
            console.log(`Original event time: ${eventStart.toISOString()}`);
            
            // Convert the event time to the client's timezone for slot key generation
            const eventDateInClientTZ = new Date(eventStart.toLocaleString("en-US", {timeZone: clientTimezone}));
            const eventEndInClientTZ = new Date(eventEnd.toLocaleString("en-US", {timeZone: clientTimezone}));
            
            console.log(`Event "${event.summary}" in ${clientTimezone}:`);
            console.log(`  Meeting: ${eventDateInClientTZ.toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit', hour12: true})} - ${eventEndInClientTZ.toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit', hour12: true})}`);
            
            // Add warm-up slots - block time before meeting starts
            const warmupDurationMs = CONFIG.WARMUP_MINUTES * 60 * 1000;
            const warmupSlotsNeeded = Math.ceil(warmupDurationMs / (30 * 60 * 1000)); // Number of 30-min slots needed
            
            console.log(`  Adding ${warmupSlotsNeeded} warm-up slots (${CONFIG.WARMUP_MINUTES} min before meeting)`);
            
            for (let i = warmupSlotsNeeded - 1; i >= 0; i--) {
                const warmupSlotTime = new Date(eventDateInClientTZ.getTime() - ((i + 1) * 30 * 60 * 1000));
                const warmupDate = warmupSlotTime.toDateString();
                const warmupHour = warmupSlotTime.getHours();
                const warmupMinute = warmupSlotTime.getMinutes();
                
                // Round to nearest 30-minute slot
                const roundedWarmupMinute = warmupMinute < 30 ? 0 : 30;
                const warmupSlotKey = `${warmupDate}_${warmupHour}_${roundedWarmupMinute}`;
                bookedSlots.add(warmupSlotKey);
                console.log(`    Warm-up slot: ${warmupSlotKey} (${warmupHour}:${String(roundedWarmupMinute).padStart(2, '0')})`);
            }
            
            const eventDuration = eventEndInClientTZ.getTime() - eventDateInClientTZ.getTime();
            const slotsToBlock = Math.ceil(eventDuration / (30 * 60 * 1000)); // 30-minute slots

            console.log(`  Adding ${slotsToBlock} meeting slots`);
            
            // Block the meeting time slots
            for (let i = 0; i < slotsToBlock; i++) {
                const slotTime = new Date(eventDateInClientTZ.getTime() + (i * 30 * 60 * 1000));
                const date = slotTime.toDateString();
                const hour = slotTime.getHours();
                const minute = slotTime.getMinutes();
                
                // Round to nearest 30-minute slot
                const roundedMinute = minute < 30 ? 0 : 30;
                const slotKey = `${date}_${hour}_${roundedMinute}`;
                bookedSlots.add(slotKey);
                console.log(`    Meeting slot: ${slotKey} (${hour}:${String(roundedMinute).padStart(2, '0')})`);
            }
            
            // Add cooldown slots - start immediately when meeting ends
            const cooldownDurationMs = CONFIG.COOLDOWN_MINUTES * 60 * 1000;
            const cooldownSlotsNeeded = Math.ceil(cooldownDurationMs / (30 * 60 * 1000)); // Number of 30-min slots needed
            
            console.log(`  Adding ${cooldownSlotsNeeded} cooldown slots (${CONFIG.COOLDOWN_MINUTES} min after meeting)`);
            
            for (let i = 0; i < cooldownSlotsNeeded; i++) {
                const cooldownSlotTime = new Date(eventEndInClientTZ.getTime() + (i * 30 * 60 * 1000));
                const cooldownDate = cooldownSlotTime.toDateString();
                const cooldownHour = cooldownSlotTime.getHours();
                const cooldownMinute = cooldownSlotTime.getMinutes();
                
                // Round to nearest 30-minute slot
                const roundedCooldownMinute = cooldownMinute < 30 ? 0 : 30;
                const cooldownSlotKey = `${cooldownDate}_${cooldownHour}_${roundedCooldownMinute}`;
                bookedSlots.add(cooldownSlotKey);
                console.log(`    Cooldown slot: ${cooldownSlotKey} (${cooldownHour}:${String(roundedCooldownMinute).padStart(2, '0')})`);
            }
        });

        console.log(`Total booked slots generated: ${bookedSlots.size}`);
        if (bookedSlots.size > 0) {
            console.log('Sample booked slots:', Array.from(bookedSlots).slice(0, 10));
        }

        res.json({
            success: true,
            bookedSlots: Array.from(bookedSlots)
        });
    } catch (error) {
        console.error('Error fetching availability:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch availability' });
    }
});

// Book an appointment
app.post('/api/book', async (req, res) => {
    try {
        const { name, email, phone, date, time, dateDisplay, timeDisplay, timezone, qualificationData } = req.body;
        
        // Validate required fields
        if (!name || !email || !phone || !date || !time) {
            return res.status(400).json({ 
                success: false, 
                message: 'All fields are required' 
            });
        }

        // Validate time slot availability
        const appointmentTime = new Date(time);
        const now = new Date();
        const minBookingTime = new Date(now.getTime() + (CONFIG.MIN_BOOKING_HOURS * 60 * 60 * 1000));
        
        if (appointmentTime < minBookingTime) {
            return res.status(400).json({
                success: false,
                message: 'Cannot book within 1 hour of current time'
            });
        }

        // Check if slot is already booked using the client's timezone
        const clientTimezone = timezone || 'America/Phoenix';
        const appointmentTimeInClientTZ = new Date(appointmentTime.toLocaleString("en-US", {timeZone: clientTimezone}));
        const slotKey = `${appointmentTimeInClientTZ.toDateString()}_${appointmentTimeInClientTZ.getHours()}_${appointmentTimeInClientTZ.getMinutes()}`;
        
        const existingBooking = bookings.find(booking => booking.slotKey === slotKey);
        
        if (existingBooking) {
            return res.status(400).json({
                success: false,
                message: 'This time slot is no longer available'
            });
        }

        // Format qualification data for calendar description
        const qualificationDetails = qualificationData ? formatQualificationData(qualificationData) : '';

        // Create Google Calendar event with Google Meet link
        const endTime = new Date(appointmentTime.getTime() + (30 * 60 * 1000)); // 30 minutes
        
        const event = {
            summary: `Ecom Growth Discovery Call - ${name}`,
            description: `
🎯 ECOM GROWTH PARTNERSHIP DISCOVERY CALL

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 CONTACT INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📧 Email: ${email}
📞 Phone: ${phone}
🌍 Timezone: ${clientTimezone}
📅 Booked via: Calendar System
${qualificationDetails}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎥 MEETING DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 Google Meet link will be automatically added to this event
⏰ Duration: 30 minutes
🔔 You'll receive reminder notifications

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 CALL NOTES SECTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Add your call notes here]


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ NEXT STEPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Add next steps here]
            `,
            start: {
                dateTime: appointmentTime.toISOString(),
                timeZone: clientTimezone
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: clientTimezone
            },
            attendees: [
                { email: email }
            ],
            conferenceData: {
                createRequest: {
                    requestId: `meet-${Date.now()}`, // Unique ID for the request
                    conferenceSolutionKey: {
                        type: 'hangoutsMeet'
                    }
                }
            },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 }, // 24 hours
                    { method: 'popup', minutes: 30 }
                ]
            }
        };

        console.log('Creating calendar event with qualification data and Google Meet:', {
            summary: event.summary,
            start: event.start,
            end: event.end,
            timezone: clientTimezone,
            hasQualificationData: !!qualificationData,
            meetingRequested: true
        });

        const calendarResponse = await calendar.events.insert({
            calendarId: CONFIG.CALENDAR_ID,
            resource: event,
            conferenceDataVersion: 1, // Required for Google Meet integration
            sendUpdates: 'all'
        });

        // Store booking locally with qualification data
        const booking = {
            id: Date.now().toString(),
            name,
            email,
            phone,
            date: appointmentTime,
            dateDisplay,
            timeDisplay,
            slotKey,
            timezone: clientTimezone,
            googleEventId: calendarResponse.data.id,
            meetLink: calendarResponse.data.hangoutLink || calendarResponse.data.conferenceData?.entryPoints?.[0]?.uri,
            qualificationData: qualificationData || {},
            createdAt: new Date()
        };
        
        bookings.push(booking);

        // Tag customer in Shopify with qualification data
        await tagShopifyCustomer(email, name, phone, qualificationData);

        // Send confirmation email with qualification summary
        await sendConfirmationEmail(booking);

        res.json({
            success: true,
            message: 'Appointment booked successfully',
            booking: {
                id: booking.id,
                date: dateDisplay,
                time: timeDisplay,
                timezone: clientTimezone,
                googleEventId: calendarResponse.data.id
            }
        });

    } catch (error) {
        console.error('Error booking appointment:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to book appointment. Please try again.' 
        });
    }
});

// Tag customer in Shopify with qualification data
async function tagShopifyCustomer(email, name, phone, qualificationData = {}) {
    try {
        // First, search for existing customer
        const searchResponse = await axios.get(
            `${CONFIG.SHOPIFY_STORE_URL}/admin/api/2023-10/customers/search.json?query=email:${email}`,
            {
                headers: {
                    'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );

        let customer;
        
        // Create tags based on qualification data
        const tags = ['call-booked'];
        
        if (qualificationData.current_revenue) {
            tags.push(`revenue-${qualificationData.current_revenue}`);
        }
        if (qualificationData.revenue_goal) {
            tags.push(`goal-${qualificationData.revenue_goal}`);
        }
        if (qualificationData.ad_spend) {
            tags.push(`spend-${qualificationData.ad_spend}`);
        }
        if (qualificationData.problems) {
            tags.push(`problem-${qualificationData.problems}`);
        }
        if (qualificationData.channels) {
            tags.push(`channel-${qualificationData.channels}`);
        }
        
        if (searchResponse.data.customers && searchResponse.data.customers.length > 0) {
            // Customer exists, update tags and metafields
            customer = searchResponse.data.customers[0];
            const currentTags = customer.tags ? customer.tags.split(', ') : [];
            
            // Add new tags that don't already exist
            tags.forEach(tag => {
                if (!currentTags.includes(tag)) {
                    currentTags.push(tag);
                }
            });
            
            const metafields = [];
            
            // Add qualification data as metafields
            Object.entries(qualificationData).forEach(([key, value]) => {
                if (value) {
                    metafields.push({
                        namespace: 'qualification',
                        key: key,
                        value: value,
                        type: 'single_line_text_field'
                    });
                }
            });
            
            await axios.put(
                `${CONFIG.SHOPIFY_STORE_URL}/admin/api/2023-10/customers/${customer.id}.json`,
                {
                    customer: {
                        id: customer.id,
                        tags: currentTags.join(', '),
                        metafields: metafields
                    }
                },
                {
                    headers: {
                        'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    }
                }
            );
        } else {
            // Create new customer with qualification data
            const metafields = [
                {
                    namespace: 'booking',
                    key: 'booking_time',
                    value: new Date().toISOString(),
                    type: 'date_time'
                },
                {
                    namespace: 'booking',
                    key: 'date',
                    value: new Date().toISOString().split('T')[0],
                    type: 'date'
                }
            ];
            
            // Add qualification data as metafields
            Object.entries(qualificationData).forEach(([key, value]) => {
                if (value) {
                    metafields.push({
                        namespace: 'qualification',
                        key: key,
                        value: value,
                        type: 'single_line_text_field'
                    });
                }
            });

            const newCustomer = {
                customer: {
                    email: email,
                    first_name: name.split(' ')[0],
                    last_name: name.split(' ').slice(1).join(' '),
                    phone: phone,
                    tags: tags.join(', '),
                    metafields: metafields
                }
            };

            await axios.post(
                `${CONFIG.SHOPIFY_STORE_URL}/admin/api/2023-10/customers.json`,
                newCustomer,
                {
                    headers: {
                        'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                        'Content-Type': 'application/json'
                    }
                }
            );
        }

        console.log('Successfully tagged customer in Shopify with qualification data');
    } catch (error) {
        console.error('Error tagging Shopify customer:', error.response?.data || error.message);
        // Don't throw error - booking should still succeed even if Shopify tagging fails
    }
}

// Send confirmation email with qualification summary
async function sendConfirmationEmail(booking) {
    try {
        const qualificationSummary = booking.qualificationData ? 
            Object.entries(booking.qualificationData)
                .map(([key, value]) => `<strong>${key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}:</strong> ${value}`)
                .join('<br>') : 
            'No qualification data provided';

        const meetLinkSection = booking.meetLink ? 
            `<div style="background: #e1f5fe; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2196f3;">
                <h4 style="color: #1976d2; margin: 0 0 10px 0;">🎥 Join the Meeting</h4>
                <p style="margin: 0;"><strong>Google Meet Link:</strong> <a href="${booking.meetLink}" style="color: #1976d2;">${booking.meetLink}</a></p>
                <p style="margin: 5px 0 0 0; font-size: 12px; color: #666;">You can also find this link in the calendar invite</p>
            </div>` :
            `<div style="background: #e1f5fe; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2196f3;">
                <h4 style="color: #1976d2; margin: 0 0 10px 0;">🎥 Meeting Location</h4>
                <p style="margin: 0;">Google Meet link will be included in your calendar invite</p>
            </div>`;

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: booking.email,
            subject: 'Ecom Growth Discovery Call Confirmation - Google Meet Included',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">Your Discovery Call is Confirmed!</h2>
                    
                    <p>Hi ${booking.name},</p>
                    
                    <p>Your Ecom Growth Partnership Discovery Call has been successfully booked for:</p>
                    
                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <strong>Date:</strong> ${booking.dateDisplay}<br>
                        <strong>Time:</strong> ${booking.timeDisplay}<br>
                        <strong>Duration:</strong> 30 minutes<br>
                        <strong>Timezone:</strong> ${booking.timezone}
                    </div>
                    
                    ${meetLinkSection}
                    
                    <p>We'll contact you at <strong>${booking.phone}</strong> at the scheduled time and will also be available via Google Meet.</p>
                    
                    <h3 style="color: #667eea; margin-top: 30px;">What We Discussed</h3>
                    <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0; font-size: 14px;">
                        ${qualificationSummary}
                    </div>
                    
                    <p>If you need to reschedule or cancel, please contact us as soon as possible.</p>
                    
                    <p>Looking forward to speaking with you!</p>
                    
                    <hr style="margin: 30px 0;">
                    <p style="color: #666; font-size: 12px;">
                        This appointment has been added to your calendar with Google Meet link included. Check your email for the calendar invite.
                    </p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('Confirmation email sent successfully with qualification summary and meet info');
    } catch (error) {
        console.error('Error sending confirmation email:', error);
        // Don't throw error - booking should still succeed even if email fails
    }
}

// Get all bookings with qualification data (admin endpoint)
app.get('/api/bookings', (req, res) => {
    res.json({
        success: true,
        bookings: bookings.map(booking => ({
            id: booking.id,
            name: booking.name,
            email: booking.email,
            phone: booking.phone,
            date: booking.dateDisplay,
            time: booking.timeDisplay,
            timezone: booking.timezone,
            meetLink: booking.meetLink,
            qualificationData: booking.qualificationData,
            googleEventId: booking.googleEventId,
            createdAt: booking.createdAt
        }))
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend available at: http://localhost:${PORT}`);
});

module.exports = app;
