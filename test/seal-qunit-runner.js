/*
 * Headless runner for the jQuery QUnit suite (test/index.html).
 *
 * jQuery 1.11's own CI ran this suite only in real browsers via TestSwarm;
 * `npm test` merely builds and lints. This script drives the same page in
 * headless Chrome (puppeteer-core) and prints one line per QUnit test plus
 * a summary, exiting non-zero if any test fails or the run does not finish.
 *
 * Usage: node test/seal-qunit-runner.js <url-of-test/index.html>
 * Requires Node >= 18, puppeteer-core on NODE_PATH and CHROME_BIN.
 */
"use strict";

const puppeteer = require( "puppeteer-core" );

const url = process.argv[ 2 ];
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

// Tests that cannot pass in a current headless Chrome because they assert
// 2014-era browser behaviour; each is reported as SKIP with its reason.
const SKIPPED_TESTS = {
	"support :: Check CSP (https://developer.mozilla.org/en-US/docs/Security/CSP) restrictions":
		"current Chrome sends a CSP violation report for jQuery 1.11's inline " +
		"event-attribute support probe, so csp.log is non-empty",
	"ajax :: #14379 - jQuery.ajax() on unload":
		"Chrome 80+ forbids synchronous XHR during page dismissal (unload), " +
		"so the request the fixture sends from onunload always errors",
	"offset :: fractions (see #7730 and #7885)":
		"Chrome's LayoutNG stores positions in 1/64px fixed point, so " +
		"top 1000 reads back as 999.984375"
};

function hook( skipped ) {
	if ( window.top !== window ) {
		return;
	}
	let q;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		get: function() {
			return q;
		},
		set: function( value ) {
			q = value;
			if ( !value || value.__sealHooked ) {
				return;
			}
			value.__sealHooked = true;
			value.config.testTimeout = 60000;

			// testinit.js loadTests() calls QUnit.load()/QUnit.start() once the
			// test files are loaded; QUnit also calls QUnit.load() on window
			// "load". If the test files win that race, the window-load
			// QUnit.load() -> QUnit.init() wipes the running test's output row
			// and QUnit crashes ("Cannot set properties of null"), hanging the
			// suite. Defer such early calls until after window "load", which
			// is the order a normal page load produces.
			let pageLoaded = false;
			const pending = [];
			window.addEventListener( "load", function() {
				setTimeout( function() {
					pageLoaded = true;
					pending.splice( 0 ).forEach( function( f ) {
						f();
					} );
				}, 0 );
			} );
			[ "load", "start" ].forEach( function( method ) {
				const original = value[ method ];
				value[ method ] = function() {
					const self = this, args = arguments;
					if ( pageLoaded ) {
						return original.apply( self, args );
					}
					pending.push( function() {
						original.apply( self, args );
					} );
				};
			} );

			// Skip the tests listed in SKIPPED_TESTS (by "module :: name").
			[ "test", "asyncTest" ].forEach( function( fn ) {
				const original = window[ fn ];
				window[ fn ] = function( name ) {
					const label = value.config.currentModule + " :: " + name;
					if ( Object.prototype.hasOwnProperty.call( skipped, label ) ) {
						window.__sealSkip( label );
						return;
					}
					return original.apply( this, arguments );
				};
			} );

			let failures = [];
			value.log( function( d ) {
				if ( !d.result ) {
					failures.push( ( d.message || "" ) +
						( "expected" in d ? " | expected: " + String( d.expected ) : "" ) +
						( "actual" in d ? " | actual: " + String( d.actual ) : "" ) +
						( d.source ? " | source: " + String( d.source ).split( "\n" )[ 0 ] : "" ) );
				}
			} );
			value.testDone( function( d ) {
				window.__sealTestDone( {
					module: d.module, name: d.name, failed: d.failed,
					passed: d.passed, total: d.total, failures: failures
				} );
				failures = [];
			} );
			value.done( function( d ) {
				window.__sealDone( { failed: d.failed, passed: d.passed, total: d.total, runtime: d.runtime } );
			} );
		}
	} );
}

( async function() {
	const browser = await puppeteer.launch( {
		executablePath: process.env.CHROME_BIN,
		headless: true,
		args: [
			"--no-sandbox", "--disable-dev-shm-usage",

			// Keep the "unload" event firing (data #10080 listens for an
			// iframe's unload); current Chrome's unload deprecation rollout
			// can otherwise suppress it.
			"--disable-features=DeprecateUnload,DeprecateUnloadByAllowList"
		]
	} );
	const page = await browser.newPage();
	await page.setViewport( { width: 1280, height: 1024 } );

	let testsPassed = 0, testsFailed = 0;
	const failedTests = [], skippedTests = [];
	let resolveDone;
	const done = new Promise( function( resolve ) {
		resolveDone = resolve;
	} );

	await page.exposeFunction( "__sealSkip", function( label ) {
		skippedTests.push( label );
		console.log( "SKIP " + label + " -- " + SKIPPED_TESTS[ label ] );
	} );
	await page.exposeFunction( "__sealTestDone", function( t ) {
		const label = t.module + " :: " + t.name;
		if ( t.failed === 0 ) {
			testsPassed++;
			console.log( "PASS " + label + " (" + t.passed + "/" + t.total + " assertions)" );
		} else {
			testsFailed++;
			failedTests.push( label );
			console.log( "FAIL " + label + " (" + t.failed + " of " + t.total + " assertions failed)" );
			t.failures.forEach( function( f ) {
				console.log( "    - " + f );
			} );
		}
	} );
	await page.exposeFunction( "__sealDone", function( d ) {
		resolveDone( d );
	} );
	await page.evaluateOnNewDocument( hook, SKIPPED_TESTS );

	page.on( "pageerror", function( e ) {
		console.log( "PAGE ERROR: " + ( e.stack || e.message ) );
	} );
	page.on( "dialog", function( d ) {
		d.dismiss();
	} );

	console.log( "Running QUnit suite at " + url );
	await page.goto( url, { waitUntil: "load", timeout: 120000 } );

	const timeout = new Promise( function( resolve ) {
		setTimeout( function() {
			resolve( null );
		}, RUN_TIMEOUT_MS );
	} );
	const result = await Promise.race( [ done, timeout ] );
	await browser.close();

	console.log( "" );
	console.log( "==================== QUnit summary ====================" );
	if ( !result ) {
		console.log( "Suite did not finish within " + RUN_TIMEOUT_MS / 60000 + " minutes" );
		console.log( "Tests passed: " + testsPassed + ", tests failed: " + testsFailed );
		process.exit( 1 );
	}
	console.log( "Tests: " + ( testsPassed + testsFailed ) + " run, " + testsPassed +
		" passed, " + testsFailed + " failed, " + skippedTests.length + " skipped" );
	console.log( "Assertions: " + result.total + " total, " + result.passed + " passed, " +
		result.failed + " failed (" + result.runtime + " ms)" );
	skippedTests.forEach( function( name ) {
		console.log( "  skipped: " + name + " -- " + SKIPPED_TESTS[ name ] );
	} );
	failedTests.forEach( function( name ) {
		console.log( "  failed: " + name );
	} );
	process.exit( result.failed === 0 && testsFailed === 0 ? 0 : 1 );
} )().catch( function( e ) {
	console.error( e );
	process.exit( 1 );
} );
