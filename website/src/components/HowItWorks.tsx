"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, MessageSquareText, CircleDollarSign, KeyRound } from "lucide-react";

const INTERVAL_MS = 5000;

const tabs = [
  {
    label: "Discover",
    icon: Search,
    heading: "Fetch the agent card",
    code: `GET /.well-known/agent.json

{
  "name": "Photo API",
  "skills": [{
    "id": "request-access",
    "pricing": [
      { "tier": "single", "amount": "$0.10", "asset": "USDC" },
      { "tier": "album",  "amount": "$1.00", "asset": "USDC" }
    ]
  }]
}`,
  },
  {
    label: "Request",
    icon: MessageSquareText,
    heading: "Request access to a resource",
    code: `POST /agent  →  AccessRequest
{
  "resourceId": "photo-1",
  "tierId": "single"
}

← X402Challenge
{
  "amount": "$0.10",
  "asset": "USDC",
  "destination": "0x1a2b…3c4d",
  "expiresAt": "2026-03-01T12:05:00Z"
}`,
  },
  {
    label: "Pay",
    icon: CircleDollarSign,
    heading: "Send USDC on Base",
    code: `USDC Transfer on Base

From:   0xBuyerWallet
To:     0xSellerWallet
Amount: 0.10 USDC

✓  Confirmed
   txHash: 0xabc…def`,
  },
  {
    label: "Access",
    icon: KeyRound,
    heading: "Get a token and call the API",
    code: `POST /agent  →  PaymentProof
{ "txHash": "0xabc…def" }

← AccessGrant
{ "accessToken": "eyJhbG…",
  "resourceEndpoint": "/api/photos/photo-1" }

GET /api/photos/photo-1
Authorization: Bearer eyJhbG…

← { "id": "photo-1", "url": "…", "title": "Sunset" }`,
  },
];

function DiscoveryAnimation() {
  return (
    <svg
      viewBox="0 0 500 350"
      className="w-full h-full object-contain"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        fontFamily: "var(--font-jakarta), 'Plus Jakarta Sans', sans-serif",
        transform: "scale(1.2)",
        transformOrigin: "center",
      }}
    >
      <defs>
        <filter id="step1-neumorphic" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur1" />
          <feOffset dx="3" dy="3" result="offset1" />
          <feFlood floodColor="#9a9a9a" floodOpacity="0.5" result="color1" />
          <feComposite in="color1" in2="offset1" operator="in" result="shadow1" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur2" />
          <feOffset dx="-3" dy="-3" result="offset2" />
          <feFlood floodColor="#ffffff" floodOpacity="0.55" result="color2" />
          <feComposite in="color2" in2="offset2" operator="in" result="shadow2" />
          <feMerge>
            <feMergeNode in="shadow1" />
            <feMergeNode in="shadow2" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <path id="step1-arc-path" d="M 120 228 Q 250 80 380 165" fill="none" />
      </defs>

      <ellipse cx="120" cy="269" rx="46" ry="23" fill="rgba(0,0,0,0.06)" />
      <ellipse cx="380" cy="275" rx="32" ry="16" fill="rgba(0,0,0,0.06)" />
      <use
        href="#step1-arc-path"
        stroke="#a3a3a3"
        strokeWidth="2"
        strokeDasharray="6 6"
        opacity="0.4"
      />

      <text
        x="250"
        y="97"
        textAnchor="middle"
        fontSize="16"
        fontWeight="700"
        fill="#1a1a1a"
        opacity="1"
      >
        GET agent card
        <animate
          attributeName="opacity"
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.22; 0.3; 1"
          values="1; 1; 0; 0"
        />
      </text>
      <text
        x="120"
        y="97"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fill="#1a1a1a"
        opacity="0"
      >
        /.well-known/agent.json
        <animate
          attributeName="opacity"
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.5; 0.56; 0.85; 0.92; 1"
          values="0; 0; 1; 1; 0; 0"
        />
      </text>
      <text
        x="120"
        y="114"
        textAnchor="middle"
        fontSize="12"
        fontWeight="700"
        fill="#1a1a1a"
        opacity="0"
      >
        received
        <animate
          attributeName="opacity"
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.5; 0.56; 0.85; 0.92; 1"
          values="0; 0; 1; 1; 0; 0"
        />
      </text>

      <g>
        <polygon points="120,206 164,228 120,250 76,228" fill="#EFEFEF" />
        <polygon points="76,228 120,250 120,280 76,258" fill="#c8c8c8" />
        <polygon points="120,250 164,228 164,258 120,280" fill="#b0b0b0" />
        <text
          x="120"
          y="315"
          textAnchor="middle"
          fontSize="12"
          fontWeight="700"
          fill="#1a1a1a"
          letterSpacing="1"
        >
          AGENT
        </text>
      </g>
      <g>
        <polygon points="380,150 410,165 380,180 350,165" fill="#EFEFEF" />
        <polygon points="350,165 380,180 380,280 350,265" fill="#c8c8c8" />
        <polygon points="380,180 410,165 410,265 380,280" fill="#b0b0b0" />
        <text
          x="380"
          y="315"
          textAnchor="middle"
          fontSize="12"
          fontWeight="700"
          fill="#1a1a1a"
          letterSpacing="1"
        >
          SERVER
        </text>
      </g>

      <g opacity="1">
        <rect x="-10" y="-10" width="20" height="20" rx="2" fill="#1a1a1a" />
        <line
          x1="-5"
          y1="-4"
          x2="5"
          y2="-4"
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line x1="-5" y1="0" x2="5" y2="0"         stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="-5" y1="4" x2="2" y2="4" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <animateMotion
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.3; 1"
          keyPoints="0; 1; 1"
          calcMode="spline"
          keySplines="0.45 0 0.55 1; 0 0 1 1"
        >
          <mpath href="#step1-arc-path" />
        </animateMotion>
        <animate
          attributeName="opacity"
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.22; 0.3; 1"
          values="1; 1; 0; 0"
        />
      </g>

      <g opacity="0">
        <rect x="-11" y="-15" width="22" height="30" rx="3" fill="#1a1a1a" />
        <circle cx="0" cy="-6" r="3.5" fill="#ffffff" />
        <line
          x1="-5"
          y1="3"
          x2="5"
          y2="3"
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line x1="-5" y1="8" x2="2" y2="8" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <animateMotion
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.375; 0.675; 1"
          keyPoints="1; 1; 0; 0"
          calcMode="spline"
          keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
        >
          <mpath href="#step1-arc-path" />
        </animateMotion>
        <animate
          attributeName="opacity"
          dur="4.8s"
          repeatCount="indefinite"
          keyTimes="0; 0.375; 0.43; 0.62; 0.675; 1"
          values="0; 0; 1; 1; 0; 0"
        />
      </g>

      {/* Photo API + rate cards: above Server, appear after GET agent card has faded, then stay visible */}
      <g transform="translate(380, 60)">
        <g opacity="0">
          <animate
            attributeName="opacity"
            dur="4.8s"
            repeatCount="indefinite"
            keyTimes="0; 0.32; 0.38; 0.92; 0.98; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <text x="0" y="0" textAnchor="middle" fontSize="13" fontWeight="700" fill="#1a1a1a">
            Photo API
          </text>
        </g>
        <g opacity="0">
          <animate
            attributeName="opacity"
            dur="4.8s"
            repeatCount="indefinite"
            keyTimes="0; 0.32; 0.38; 0.92; 0.98; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            dur="4.8s"
            repeatCount="indefinite"
            keyTimes="0; 0.32; 0.38; 1"
            values="0 25; 0 25; 0 15; 0 15"
            calcMode="spline"
            keySplines="0 0 1 1; 0.2 0 0.2 1; 0 0 1 1"
          />
          <rect
            x="-70"
            y="0"
            width="140"
            height="36"
            rx="8"
            fill="#E8E8E8"
            filter="url(#step1-neumorphic)"
          />
          <text x="0" y="22" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a">
            Single / <tspan fill="#1a1a1a" fontWeight="700">$0.10 USDC</tspan>
          </text>
        </g>
        <g opacity="0">
          <animate
            attributeName="opacity"
            dur="4.8s"
            repeatCount="indefinite"
            keyTimes="0; 0.38; 0.44; 0.92; 0.98; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            dur="4.8s"
            repeatCount="indefinite"
            keyTimes="0; 0.38; 0.44; 1"
            values="0 70; 0 70; 0 60; 0 60"
            calcMode="spline"
            keySplines="0 0 1 1; 0.2 0 0.2 1; 0 0 1 1"
          />
          <rect
            x="-70"
            y="0"
            width="140"
            height="36"
            rx="8"
            fill="#E8E8E8"
            filter="url(#step1-neumorphic)"
          />
          <text x="0" y="22" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a">
            Album / <tspan fill="#1a1a1a" fontWeight="700">$1.00 USDC</tspan>
          </text>
        </g>
      </g>
    </svg>
  );
}

function RequestAnimation() {
  return (
    <svg
      viewBox="0 0 500 350"
      className="w-full h-full object-contain"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        fontFamily: "var(--font-jakarta), 'Plus Jakarta Sans', sans-serif",
        transform: "translateX(-20px) scale(1.2)",
        transformOrigin: "center",
      }}
    >
      <defs>
        <filter id="step2-neu-card" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur1" />
          <feOffset dx="3" dy="3" result="offset1" />
          <feFlood floodColor="#9a9a9a" floodOpacity="0.5" result="color1" />
          <feComposite in="color1" in2="offset1" operator="in" result="shadow1" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur2" />
          <feOffset dx="-3" dy="-3" result="offset2" />
          <feFlood floodColor="#ffffff" floodOpacity="0.55" result="color2" />
          <feComposite in="color2" in2="offset2" operator="in" result="shadow2" />
          <feMerge>
            <feMergeNode in="shadow1" />
            <feMergeNode in="shadow2" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <path id="step2-arc-out" d="M 130 228 Q 204.875 111.625 285 215" fill="none" />
        <path id="step2-arc-in" d="M 285 215 Q 204.875 111.625 130 228" fill="none" />
      </defs>

      <g transform="translate(0, -40)">
      <ellipse cx="102" cy="270" rx="42" ry="16" fill="rgba(0,0,0,0.06)" />
      <ellipse cx="428" cy="275" rx="38" ry="16" fill="rgba(0,0,0,0.06)" />

      <rect
        x="260"
        y="128"
        width="222"
        height="205"
        rx="14"
        fill="#E8E8E8"
        filter="url(#step2-neu-card)"
      />

      <path
        d="M 340 235 L 404 235"
        fill="none"
        stroke="#a3a3a3"
        strokeWidth="2"
        strokeDasharray="6 6"
        opacity="0.4"
      />

      <g transform="translate(316, 278) scale(0.204) translate(-153, -316)">
        <path
          d="M179 16C189.182 16 197.586 23.6086 198.838 33.4502L290 289.5L289.924 289.513C290.621 291.547 291 293.729 291 296C291 306.541 282.845 315.176 272.5 315.943V316H236L225.803 288.128C222.918 280.244 215.416 275 207.021 275H98.9795C90.5839 275 83.082 280.244 80.1973 288.128L70 316H36.5V315.993C36.3338 315.997 36.1672 316 36 316C24.9543 316 16 307.046 16 296C16 293.729 16.3787 291.546 17.0762 289.512L17 289.5L109 32.5L109.328 32.376C111.033 23.0604 119.192 16 129 16H179ZM153 94C124.833 94 102 116.833 102 145C102 166.527 115.337 184.938 134.199 192.422V274.9H166.5V266.851L177.199 257.488V257.3L165.149 245.25L177.199 233.2V233L165.149 220.95L177.199 208.9V189.902C193.157 181.284 204 164.409 204 145C204 116.833 181.167 94 153 94ZM153 125C164.046 125 173 133.954 173 145C173 156.046 164.046 165 153 165C141.954 165 133 156.046 133 145C133 133.954 141.954 125 153 125Z"
          fill="#1a1a1a"
          opacity="0.82"
        />
      </g>
      <text
        x="316"
        y="302"
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        fill="#1a1a1a"
        letterSpacing="1"
        opacity="0.65"
      >
        KEY2A
      </text>

      <g>
        <polygon points="428,170 452,181 428,192 404,181" fill="#EFEFEF" />
        <polygon points="404,181 428,192 428,278 404,267" fill="#c8c8c8" />
        <polygon points="428,192 452,181 452,267 428,278" fill="#b0b0b0" />
        <text
          x="428"
          y="302"
          textAnchor="middle"
          fontSize="10"
          fontWeight="700"
          fill="#1a1a1a"
          letterSpacing="1"
          opacity="0.65"
        >
          SERVER
        </text>
      </g>

      <g>
        <polygon points="102,206 146,228 102,250 58,228" fill="#EFEFEF" />
        <polygon points="58,228 102,250 102,280 58,258" fill="#c8c8c8" />
        <polygon points="102,250 146,228 146,258 102,280" fill="#b0b0b0" />
        <text
          x="102"
          y="300"
          textAnchor="middle"
          fontSize="12"
          fontWeight="700"
          fill="#1a1a1a"
          letterSpacing="1"
        >
          AGENT
        </text>
      </g>

      <use
        href="#step2-arc-out"
        stroke="#a3a3a3"
        strokeWidth="2"
        strokeDasharray="6 6"
        opacity="0.4"
      />

      <text x="210" y="148" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a" opacity="0">
        AccessRequest
        <animate
          attributeName="opacity"
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.04; 0.12; 0.28; 0.36; 1"
          values="0; 0; 1; 1; 0; 0"
        />
      </text>
      <text x="210" y="148" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a" opacity="0">
        X402Challenge
        <animate
          attributeName="opacity"
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.44; 0.52; 0.70; 0.78; 1"
          values="0; 0; 1; 1; 0; 0"
        />
      </text>

      <g opacity="0">
        <rect x="-9" y="-9" width="18" height="18" rx="2" fill="#1a1a1a" />
        <line x1="-5" y1="-4" x2="5" y2="-4" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="-5" y1="0" x2="5" y2="0" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="-5" y1="4" x2="2" y2="4" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
        <animateMotion
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.34; 1"
          keyPoints="0; 1; 1"
          calcMode="spline"
          keySplines="0.45 0 0.55 1; 0 0 1 1"
        >
          <mpath href="#step2-arc-out" />
        </animateMotion>
        <animate
          attributeName="opacity"
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.02; 0.30; 0.38; 1"
          values="0; 1; 1; 0; 0"
        />
      </g>

      <g opacity="0">
        <rect x="-8" y="-1" width="16" height="11" rx="2" fill="#1a1a1a" />
        <path
          d="M -3.5 -1 L -3.5 -5.5 Q -3.5 -9 0 -9 Q 3.5 -9 3.5 -5.5 L 3.5 -1"
          stroke="#ffffff"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="0" cy="4" r="1.8" fill="#ffffff" />
        <animateMotion
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.42; 0.76; 1"
          keyPoints="0; 0; 1; 1"
          calcMode="spline"
          keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
        >
          <mpath href="#step2-arc-in" />
        </animateMotion>
        <animate
          attributeName="opacity"
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.42; 0.46; 0.74; 0.80; 1"
          values="0; 0; 1; 1; 0; 0"
        />
      </g>

      <g transform="translate(102, 95)" opacity="0">
        <animate
          attributeName="opacity"
          dur="5s"
          repeatCount="indefinite"
          keyTimes="0; 0.72; 0.77; 0.97; 1"
          values="0; 0; 1; 1; 0"
        />
        <rect
          x="-72"
          y="0"
          width="144"
          height="58"
          rx="8"
          fill="#E8E8E8"
          filter="url(#step2-neu-card)"
        />
        <text x="0" y="22" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a">
          $0.10 USDC
        </text>
        <line
          x1="-52"
          y1="32"
          x2="52"
          y2="32"
          stroke="#a3a3a3"
          strokeWidth="0.75"
          opacity="0.4"
        />
        <text x="0" y="46" textAnchor="middle" fontSize="9" fontWeight="500" fill="#1a1a1a" opacity="0.65">
          challengeId: abc-123
        </text>
      </g>
      </g>
    </svg>
  );
}

function PayAnimation() {
  return (
    <svg
      viewBox="0 0 500 350"
      className="w-full h-full object-contain"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        fontFamily: "var(--font-jakarta), 'Plus Jakarta Sans', sans-serif",
        transform: "translateX(-20px) scale(1.2)",
        transformOrigin: "center",
      }}
    >
      <defs>
        <filter id="step3-neu-card" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur1" />
          <feOffset dx="3" dy="3" result="offset1" />
          <feFlood floodColor="#9a9a9a" floodOpacity="0.5" result="color1" />
          <feComposite in="color1" in2="offset1" operator="in" result="shadow1" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur2" />
          <feOffset dx="-3" dy="-3" result="offset2" />
          <feFlood floodColor="#ffffff" floodOpacity="0.55" result="color2" />
          <feComposite in="color2" in2="offset2" operator="in" result="shadow2" />
          <feMerge>
            <feMergeNode in="shadow1" />
            <feMergeNode in="shadow2" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <path id="step3-arc-out" d="M 130 228 Q 280 32 415 180" fill="none" />
        <path id="step3-arc-in" d="M 415 180 Q 280 32 130 228" fill="none" />
      </defs>

      <g transform="translate(0, -40)">
        <ellipse cx="102" cy="270" rx="42" ry="16" fill="rgba(0,0,0,0.06)" />
        <ellipse cx="428" cy="275" rx="38" ry="16" fill="rgba(0,0,0,0.06)" />

        <rect
          x="260"
          y="128"
          width="222"
          height="205"
          rx="14"
          fill="#E8E8E8"
          filter="url(#step3-neu-card)"
        />

        <g transform="translate(316, 278) scale(0.204) translate(-153, -316)">
          <path
            d="M179 16C189.182 16 197.586 23.6086 198.838 33.4502L290 289.5L289.924 289.513C290.621 291.547 291 293.729 291 296C291 306.541 282.845 315.176 272.5 315.943V316H236L225.803 288.128C222.918 280.244 215.416 275 207.021 275H98.9795C90.5839 275 83.082 280.244 80.1973 288.128L70 316H36.5V315.993C36.3338 315.997 36.1672 316 36 316C24.9543 316 16 307.046 16 296C16 293.729 16.3787 291.546 17.0762 289.512L17 289.5L109 32.5L109.328 32.376C111.033 23.0604 119.192 16 129 16H179ZM153 94C124.833 94 102 116.833 102 145C102 166.527 115.337 184.938 134.199 192.422V274.9H166.5V266.851L177.199 257.488V257.3L165.149 245.25L177.199 233.2V233L165.149 220.95L177.199 208.9V189.902C193.157 181.284 204 164.409 204 145C204 116.833 181.167 94 153 94ZM153 125C164.046 125 173 133.954 173 145C173 156.046 164.046 165 153 165C141.954 165 133 156.046 133 145C133 133.954 141.954 125 153 125Z"
            fill="#1a1a1a"
            opacity="0.82"
          />
        </g>
        <text
          x="316"
          y="302"
          textAnchor="middle"
          fontSize="10"
          fontWeight="700"
          fill="#1a1a1a"
          letterSpacing="1"
          opacity="0.65"
        >
          KEY2A
        </text>

        <g>
          <polygon points="428,170 452,181 428,192 404,181" fill="#EFEFEF" />
          <polygon points="404,181 428,192 428,278 404,267" fill="#c8c8c8" />
          <polygon points="428,192 452,181 452,267 428,278" fill="#b0b0b0" />
          <text
            x="428"
            y="302"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#1a1a1a"
            letterSpacing="1"
            opacity="0.65"
          >
            SERVER
          </text>
        </g>

        <g>
          <polygon points="102,206 146,228 102,250 58,228" fill="#EFEFEF" />
          <polygon points="58,228 102,250 102,280 58,258" fill="#c8c8c8" />
          <polygon points="102,250 146,228 146,258 102,280" fill="#b0b0b0" />
          <text
            x="102"
            y="300"
            textAnchor="middle"
            fontSize="12"
            fontWeight="700"
            fill="#1a1a1a"
            letterSpacing="1"
          >
            AGENT
          </text>
        </g>

        <use
          href="#step3-arc-out"
          stroke="#a3a3a3"
          strokeWidth="2"
          strokeDasharray="6 6"
          opacity="0.4"
        />

        <text x="272" y="106" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a" opacity="0">
          $0.10 USDC
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.04; 0.12; 0.32; 0.40; 1"
            values="0; 0; 1; 1; 0; 0"
          />
        </text>
        <text x="272" y="106" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a1a1a" opacity="0">
          tx confirmed
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.50; 0.58; 0.72; 0.80; 1"
            values="0; 0; 1; 1; 0; 0"
          />
        </text>

        <g opacity="0">
          <animateMotion
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.40; 1"
            keyPoints="0; 1; 1"
            calcMode="spline"
            keySplines="0.45 0 0.55 1; 0 0 1 1"
          >
            <mpath href="#step3-arc-out" />
          </animateMotion>
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.02; 0.36; 0.44; 1"
            values="0; 1; 1; 0; 0"
          />
          {/* Coin stack facing viewer, spinning around Y axis via horizontal scale */}
          <g>
            <animateTransform
              attributeName="transform"
              type="scale"
              values="1 1;0.08 1;1 1"
              keyTimes="0;0.5;1"
              dur="1s"
              repeatCount="indefinite"
            />
            {/* Back to front stack of coins */}
            <circle cx="4.5" cy="2.7" r="13" fill="#666666" opacity="0.65" />
            <circle cx="4.0" cy="2.4" r="13.2" fill="#5f5f5f" opacity="0.68" />
            <circle cx="3.5" cy="2.1" r="13.4" fill="#585858" opacity="0.72" />
            <circle cx="3.0" cy="1.8" r="13.6" fill="#515151" opacity="0.75" />
            <circle cx="2.5" cy="1.5" r="13.8" fill="#4a4a4a" opacity="0.78" />
            <circle cx="2.0" cy="1.2" r="14.0" fill="#434343" opacity="0.82" />
            <circle cx="1.5" cy="0.9" r="14.2" fill="#3c3c3c" opacity="0.86" />
            <circle cx="1.0" cy="0.6" r="14.4" fill="#333333" opacity="0.9" />
            <circle cx="0.5" cy="0.3" r="14.7" fill="#262626" opacity="0.95" />
            {/* Front coin */}
            <circle cx="0" cy="0" r="15" fill="#1a1a1a" />
            {/* Dollar symbol on front */}
            <text
              x="0"
              y="0"
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="18"
              fontWeight="700"
              fill="#ffffff"
            >
              $
            </text>
          </g>
        </g>

        <g opacity="0">
          <rect x="-9" y="-9" width="18" height="18" rx="3" fill="#1a1a1a" />
          <polyline
            points="-4,0.5 -1,4 5.5,-4"
            stroke="#ffffff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <animateMotion
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.48; 0.78; 1"
            keyPoints="0; 0; 1; 1"
            calcMode="spline"
            keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
          >
            <mpath href="#step3-arc-in" />
          </animateMotion>
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.48; 0.52; 0.76; 0.82; 1"
            values="0; 0; 1; 1; 0; 0"
          />
        </g>

        <g transform="translate(102, 90)" opacity="0">
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.80; 0.87; 0.95; 0.99; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <rect
            x="-72"
            y="0"
            width="144"
            height="62"
            rx="8"
            fill="#E8E8E8"
            filter="url(#step3-neu-card)"
          />
          <text x="0" y="20" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#1a1a1a">
            tx confirmed ✓
          </text>
          <line
            x1="-52"
            y1="30"
            x2="52"
            y2="30"
            stroke="#a3a3a3"
            strokeWidth="0.75"
            opacity="0.4"
          />
          <text x="0" y="48" textAnchor="middle" fontSize="9" fontWeight="500" fill="#1a1a1a" opacity="0.65">
            0xabc...def123
          </text>
        </g>
      </g>
    </svg>
  );
}

export default function HowItWorks() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progressKey, setProgressKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const advance = useCallback(() => {
    setActive((prev) => (prev + 1) % tabs.length);
    setProgressKey((k) => k + 1);
  }, []);

  const goTo = useCallback((idx: number) => {
    setActive(idx);
    setProgressKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(advance, INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, advance]);

  const Icon = tabs[active].icon;

  return (
    <section id="how-it-works" className="py-12 pb-[72px]">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground text-center">
          How it works
        </h2>
        <p className="mt-4 font-body text-lg text-muted text-center max-w-2xl mx-auto">
          Four steps from discovery to API access — fully automated for AI
          agents.
        </p>

        {/* Animation + Tabs container */}
        <div
          ref={containerRef}
          className="mt-14"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {/* Single section: header full width, then two columns (code | animation) */}
          <div className="rounded-card bg-surface shadow-neu-inset-deep p-6 md:p-8 flex flex-col min-h-0 h-[424px] md:h-[484px]">
            {/* Step header — full width above columns */}
            <div className="flex items-center gap-3 mb-4 shrink-0">
              <div className="w-10 h-10 rounded-inner bg-surface shadow-neu-sm flex items-center justify-center shrink-0">
                <Icon size={18} className="text-foreground" strokeWidth={2} />
              </div>
              <div>
                <span className="font-body text-xs font-medium text-muted uppercase tracking-wider">
                  Step {active + 1}
                </span>
                <h3 className="font-display text-base font-bold text-foreground leading-snug">
                  {tabs[active].heading}
                </h3>
              </div>
            </div>

            {/* Two columns: code left, animation right — one block, gutter between */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 flex-1 min-h-0">
              <pre className="overflow-auto rounded-inner bg-surface shadow-neu-inset p-4 md:p-5 font-mono text-xs md:text-sm leading-relaxed text-foreground whitespace-pre-wrap min-h-0">
                {tabs[active].code}
              </pre>
              <div className="flex items-center justify-center min-h-[160px] lg:min-h-0 overflow-hidden pb-6">
                {active === 0 && <DiscoveryAnimation />}
                {active === 1 && <RequestAnimation />}
                {active === 2 && <PayAnimation />}
                {active === 3 && <AccessAnimation />}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="mt-6 w-[60%] mx-auto grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            {tabs.map((tab, i) => {
              const TabIcon = tab.icon;
              const isActive = active === i;

              return (
                <button
                  key={tab.label}
                  onClick={() => goTo(i)}
                  className={`relative flex flex-col items-start gap-2 rounded-button p-4 font-body text-sm font-medium transition-all duration-300 ease-out text-left min-h-[44px] ${
                    isActive
                      ? "bg-surface shadow-neu-inset text-foreground"
                      : "bg-surface shadow-neu text-muted hover:-translate-y-px hover:shadow-neu-hover hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <TabIcon size={16} strokeWidth={2} />
                    <span>
                      {i + 1}. {tab.label}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full h-1 rounded-full bg-surface shadow-neu-inset overflow-hidden">
                    {isActive && (
                      <div
                        key={progressKey}
                        className={`h-full rounded-full bg-foreground progress-bar-active ${
                          paused ? "progress-bar-paused" : ""
                        }`}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function AccessAnimation() {
  return (
    <svg
      viewBox="0 0 500 350"
      className="w-full h-full object-contain"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        fontFamily: "var(--font-jakarta), 'Plus Jakarta Sans', sans-serif",
        transform: "translateX(-20px) scale(1.2)",
        transformOrigin: "center",
      }}
    >
      <defs>
        <filter id="step4-neu-card" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur1" />
          <feOffset dx="3" dy="3" result="offset1" />
          <feFlood floodColor="#9a9a9a" floodOpacity="0.5" result="color1" />
          <feComposite in="color1" in2="offset1" operator="in" result="shadow1" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur2" />
          <feOffset dx="-3" dy="-3" result="offset2" />
          <feFlood floodColor="#ffffff" floodOpacity="0.55" result="color2" />
          <feComposite in="color2" in2="offset2" operator="in" result="shadow2" />
          <feMerge>
            <feMergeNode in="shadow1" />
            <feMergeNode in="shadow2" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Phase 1: Server → Key2A */}
        <path id="step4-s2k" d="M 418 183 L 322 224" fill="none" />
        {/* Phase 2: Key2A → Agent */}
        <path id="step4-k2a" d="M 262 228 L 148 228" fill="none" />
        {/* Phase 3: Agent → Server arc */}
        <path id="step4-arc-out" d="M 130 228 Q 280 32 415 180" fill="none" />
      </defs>

      <g transform="translate(0, -40)">
        {/* Shadows under Agent + Server */}
        <ellipse cx="102" cy="270" rx="42" ry="16" fill="rgba(0,0,0,0.06)" />
        <ellipse cx="428" cy="275" rx="38" ry="16" fill="rgba(0,0,0,0.06)" />

        {/* Container for Key2A + Server */}
        <rect
          x="260"
          y="128"
          width="222"
          height="205"
          rx="14"
          fill="#E8E8E8"
          filter="url(#step4-neu-card)"
        />

        {/* Connection lines: above container, below cubes and logo */}
        {/* Arc track: Agent → Server */}
        <use
          href="#step4-arc-out"
          stroke="#CCCCCC"
          strokeWidth="2"
          strokeDasharray="6 6"
          opacity="0.7"
        />

        {/* Dashed connector: Server → Key2A (phase 1) */}
        <path
          d="M 418 183 L 322 224"
          stroke="#CCCCCC"
          strokeWidth="2"
          strokeDasharray="6 6"
          fill="none"
          opacity="0"
        >
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.08; 0.12; 0.34; 0.38; 1"
            values="0; 0; 0.9; 0.9; 0; 0"
          />
        </path>

        {/* Dashed connector: Key2A → Agent (phase 2) */}
        <path
          d="M 262 228 L 148 228"
          stroke="#CCCCCC"
          strokeWidth="2"
          strokeDasharray="6 6"
          fill="none"
          opacity="0"
        >
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.36; 0.40; 0.60; 0.64; 1"
            values="0; 0; 0.9; 0.9; 0; 0"
          />
        </path>

        {/* Key2A logo */}
        <g transform="translate(316, 278) scale(0.204) translate(-153, -316)">
          <path
            d="M179 16C189.182 16 197.586 23.6086 198.838 33.4502L290 289.5L289.924 289.513C290.621 291.547 291 293.729 291 296C291 306.541 282.845 315.176 272.5 315.943V316H236L225.803 288.128C222.918 280.244 215.416 275 207.021 275H98.9795C90.5839 275 83.082 280.244 80.1973 288.128L70 316H36.5V315.993C36.3338 315.997 36.1672 316 36 316C24.9543 316 16 307.046 16 296C16 293.729 16.3787 291.546 17.0762 289.512L17 289.5L109 32.5L109.328 32.376C111.033 23.0604 119.192 16 129 16H179ZM153 94C124.833 94 102 116.833 102 145C102 166.527 115.337 184.938 134.199 192.422V274.9H166.5V266.851L177.199 257.488V257.3L165.149 245.25L177.199 233.2V233L165.149 220.95L177.199 208.9V189.902C193.157 181.284 204 164.409 204 145C204 116.833 181.167 94 153 94ZM153 125C164.046 125 173 133.954 173 145C173 156.046 164.046 165 153 165C141.954 165 133 156.046 133 145C133 133.954 141.954 125 153 125Z"
            fill="#1a1a1a"
            opacity="0.82"
          />
        </g>
        <text
          x="316"
          y="302"
          textAnchor="middle"
          fontSize="10"
          fontWeight="700"
          fill="#1a1a1a"
          letterSpacing="1"
          opacity="0.65"
        >
          KEY2A
        </text>

        {/* Server cube */}
        <g>
          <polygon points="428,170 452,181 428,192 404,181" fill="#EFEFEF" />
          <polygon points="404,181 428,192 428,278 404,267" fill="#c8c8c8" />
          <polygon points="428,192 452,181 452,267 428,278" fill="#b0b0b0" />
          <text
            x="428"
            y="302"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#1a1a1a"
            letterSpacing="1"
            opacity="0.65"
          >
            SERVER
          </text>
        </g>

        {/* Agent cube */}
        <g>
          <polygon points="102,206 146,228 102,250 58,228" fill="#EFEFEF" />
          <polygon points="58,228 102,250 102,280 58,258" fill="#c8c8c8" />
          <polygon points="102,250 146,228 146,258 102,280" fill="#b0b0b0" />
          <text
            x="102"
            y="300"
            textAnchor="middle"
            fontSize="12"
            fontWeight="700"
            fill="#1a1a1a"
            letterSpacing="1"
          >
            AGENT
          </text>
        </g>

        {/* Labels for phases */}
        {/* Phase 1: Access Token (Server → Key2A) */}
        <text
          x="366"
          y="192"
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill="#1a1a1a"
          opacity="0"
        >
          Access Token
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.08; 0.14; 0.33; 0.38; 1"
            values="0; 0; 1; 1; 0; 0"
          />
        </text>

        {/* Phase 2: Access Token (Key2A → Agent) */}
        <text
          x="205"
          y="218"
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill="#1a1a1a"
          opacity="0"
        >
          Access Token
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.36; 0.42; 0.60; 0.64; 1"
            values="0; 0; 1; 1; 0; 0"
          />
        </text>

        {/* Phase 3: API Request on arc */}
        <text
          x="272"
          y="106"
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill="#1a1a1a"
          opacity="0"
        >
          API Request
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.66; 0.72; 0.90; 0.96; 1"
            values="0; 0; 1; 1; 0; 0"
          />
        </text>

        {/* Key icon: Server → Key2A */}
        <g opacity="0">
          <animateMotion
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.06; 0.36; 1"
            keyPoints="0; 0; 1; 1"
            calcMode="spline"
            keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
          >
            <mpath href="#step4-s2k" />
          </animateMotion>
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.08; 0.12; 0.32; 0.38; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <rect x="-10" y="-10" width="20" height="20" rx="3" fill="#1a1a1a" />
          <circle cx="-3" cy="-2" r="3.5" stroke="#ffffff" strokeWidth="1.5" fill="none" />
          <line
            x1="0.2"
            y1="-2"
            x2="7.5"
            y2="-2"
            stroke="#ffffff"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line x1="4.5" y1="-2" x2="4.5" y2="1.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="7" y1="-2" x2="7" y2="1.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
        </g>

        {/* Key icon: Key2A → Agent */}
        <g opacity="0">
          <animateMotion
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.36; 0.62; 1"
            keyPoints="0; 0; 1; 1"
            calcMode="spline"
            keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
          >
            <mpath href="#step4-k2a" />
          </animateMotion>
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.36; 0.40; 0.60; 0.64; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <rect x="-10" y="-10" width="20" height="20" rx="3" fill="#1a1a1a" />
          <circle cx="-3" cy="-2" r="3.5" stroke="#ffffff" strokeWidth="1.5" fill="none" />
          <line
            x1="0.2"
            y1="-2"
            x2="7.5"
            y2="-2"
            stroke="#ffffff"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line x1="4.5" y1="-2" x2="4.5" y2="1.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="7" y1="-2" x2="7" y2="1.5" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
        </g>

        {/* JWT received card above Agent */}
        <g transform="translate(102, 90)" opacity="0">
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.62; 0.67; 0.76; 0.80; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <rect
            x="-72"
            y="0"
            width="144"
            height="48"
            rx="8"
            fill="#E8E8E8"
            filter="url(#step4-neu-card)"
          />
          <text x="0" y="20" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#1a1a1a">
            JWT received ✓
          </text>
          <line
            x1="-52"
            y1="30"
            x2="52"
            y2="30"
            stroke="#a3a3a3"
            strokeWidth="0.75"
            opacity="0.4"
          />
          <text x="0" y="42" textAnchor="middle" fontSize="9" fontWeight="500" fill="#1a1a1a" opacity="0.65">
            Bearer eyJhb...
          </text>
        </g>

        {/* Request doc: Agent → Server arc */}
        <g opacity="0">
          <animateMotion
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.64; 0.92; 1"
            keyPoints="0; 0; 1; 1"
            calcMode="spline"
            keySplines="0 0 1 1; 0.45 0 0.55 1; 0 0 1 1"
          >
            <mpath href="#step4-arc-out" />
          </animateMotion>
          <animate
            attributeName="opacity"
            dur="5s"
            repeatCount="indefinite"
            keyTimes="0; 0.64; 0.72; 0.92; 0.96; 1"
            values="0; 0; 1; 1; 0; 0"
          />
          <rect x="-9" y="-10" width="18" height="20" rx="2" fill="#1a1a1a" />
          <line
            x1="-5"
            y1="-5"
            x2="5"
            y2="-5"
            stroke="#ffffff"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <line
            x1="-5"
            y1="-1"
            x2="5"
            y2="-1"
            stroke="#ffffff"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <line x1="-5" y1="3" x2="2" y2="3" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}
