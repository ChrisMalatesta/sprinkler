// This is a calendar module for SprinklerServer.
// Copyrigth (C) Pascal Martin, 2013.

var http = require('http');
var https = require('https');

function UnsupportedCalendar (format) {
   this.format = format;
   this.status = "error";
}

var imported = new Object();
imported.calendar = new Array();
imported.programs = new Array();
imported.received = null;

// --------------------------------------------------------------------------
// Build the calendar source DB from the sprinkler's configuration.
// (The difference is that we maintain the status for each source in the DB,
// which status we do not want to see reflected in the config saved to disk.)
//
exports.configure = function (config) {

   console.log ("Analyzing calendar sources in configuration");

   buildZoneIndex(config);

   imported.pending = null;
   imported.calendar = new Array();

   for (var i = 0; i < config.calendars.length; i++) {

      switch (config.calendars[i].format) {

      case "iCalendar":
         imported.calendar[i] = new ICalendar();
         break;

      case "XML":
         console.error (config.calendars[i].name +
                        ": XML format is not supported yet");
         imported.calendar[i] = new UnsupportedCalendar("XML");
         break;

      default:
         console.error (config.calendars[i].name +
                        ": calendar format '" +
                        config.calendars[i].format + "' is not supported");
         imported.calendar[i] =
            new UnsupportedCalendar(config.calendars[i].format);
         break;
      }
      imported.calendar[i].name = config.calendars[i].name;
      imported.calendar[i].source = config.calendars[i].source;
   }
   imported.location = config.location;

   loadNextCalendar();
}

// --------------------------------------------------------------------------
// Build a reverse index: from name to zone array index.
// This is done through a function because the configuration may change:
// we must recompute the index before each downloading of the calendar data.
//
var zoneIndex;
function buildZoneIndex(config) {
   zoneIndex = new Array();
   for (var i = 0; i < config.zones.length; i++) {
      zoneIndex[config.zones[i].name] = i;
   }
}

// --------------------------------------------------------------------------
// Transform an iCalendar event into a Javascript structure.
//
function decodeEventsFromICalendar (text) {

   var lines = text.split('\r\n');
   var events = new Array();
   var event;
   var inVevent = false;

   for (var i = 0; i < lines.length; i++) {

      var operands = lines[i].split(':');
      var attributes = operands[0].split(';');

      switch (attributes[0]) {

      case 'BEGIN':
         switch (operands[1]) {
         case 'VEVENT':
            if (inVevent) {
              console.error("BEGIN VEVENT inside EVENT at line " + i + ": " + text);
            }
            event = new Object();
            event.repeat = false;
            event.hasStart = false;
            inVevent = true;
            break;
         }
         break;

      case 'LOCATION':
         if (!inVevent) break;
         event.location = operands[1];
         break;

      case 'SUMMARY':
         if (!inVevent) break;
         event.summary = operands[1];
         break;

      case 'DESCRIPTION':
         if (!inVevent) break;
         event.description = operands[1];
         break;

      case 'DTSTART':
         if (!inVevent) break;
         event.start = new Object();
         if (attributes.length > 1) {
            for (var k = 1; k < attributes.length; k++) {
               var attribute = attributes[k].split('=');
               if (attribute.length > 1) {
                  event.start[attribute[0].toLowerCase()] = attribute[1];
               }
            }
         }
         event.start.time = operands[1];
         event.hasStart = true;
         break;

      case 'RRULE':
         if (!inVevent) break;
         event.rrule = new Object();
         if (attributes.length > 1) {
            for (var k = 1; k < attributes.length; k++) {
               var attribute = attributes[k].split('=');
               if (attribute.length > 1) {
                  event.rrule[attribute[0].toLowerCase()] = attribute[1];
               }
            }
         }
         if (operands.length > 1) {
            var values = operands[1].split(';');
            if (values.length > 1) {
               for (var k = 0; k < values.length; k++) {
                  var value = values[k].split('=');
                  if (value.length > 1) {
                     event.rrule[value[0].toLowerCase()] = value[1];
                  }
               }
            }
         }
         event.repeat = true;
         break;

      case 'END':
         switch (operands[1]) {
         case 'VEVENT':
            if (inVevent) {
               events[events.length] = event;
               inVevent = false;
            }
            break;
         }
         break;
      }
   }

   return events;
};

// --------------------------------------------------------------------------
// Compile the event description into a list of zones.
// Supported syntax:
//
//    name '=' value ' ' ...  or  name ':' value ',' ...
//
function descriptionToZones (text) {
   var zones = new Array();
   var items = text.split(/[ ,]/);
   for (var i = 0; i < items.length; i++) {
      var operands = items[i].split(/[=:]/);
      if (operands.length > 1) {
         var zone = new Object();
         zone.zone = zoneIndex[operands[0]]; // exception?
         zone.seconds = operands[1] * 60;
         zones[zones.length] = zone;
      }
   }
   return zones;
}

// --------------------------------------------------------------------------
// Retrieve options from the event description.
//
// an option is a simple name (no value).
//
function descriptionToOptions (text) {
   var options = new Object();
   options.append = false;
   var items = text.split(/[ ,]/);
   for (var i = 0; i < items.length; i++) {
      if (items[i] == 'append') {
         options.append = true;
      }
   }
   return options;
}

// --------------------------------------------------------------------------
// Translate an iCalendar event into a sprinkler program
//
var iCalendarDaysDictionary = ['SU', 'MO', 'TU','WE', 'TH', 'FR', 'SA'];

function iCalendarToProgram (calendar_name, event) {

   var program = new Object();
   program.active = true;
   program.parent = calendar_name;
   program.name = calendar_name + '/' + event.summary;
   program.start = event.start.time.slice(9,11) +
                      ':' + event.start.time.slice(11,13);
   if (event.repeat) {
      // Set the time of day, interval and day filter.
      switch (event.rrule.freq) {
      case 'DAILY':
         console.log(program.name + ': DAILY mode is not yet supported');
         return null;
      case 'WEEKLY':
         var days = event.rrule.byday.split(',');
         program.days = new Array();
         for (var k = 0; k < days.length; k++) {
            thisDay = iCalendarDaysDictionary.indexOf(days[k])
            if (thisDay >= 0) {
               program.days[program.days.length] = thisDay;
            } else {
               console.log( days[k] + ' is not a valid iCalendar day of the week');
            }
         }
         program.zones = descriptionToZones (event.description);
         program.options = descriptionToOptions (event.description);
         break;
      }
   } else {
     program.date = event.start.time.slice(0,8);
   }

   return program;
}

// --------------------------------------------------------------------------
// The iCalendar class.
//
function ICalendar () {
   this.format = "iCalendar";
   this.status = 'idle';
}

// --------------------------------------------------------------------------
// Import iCalendar events from one calendar into sprinkler programs.
//
// We may receive the data in multiple chunks. We must accumulate all data
// received until the end of the iCalendar data before we start decoding.
//
ICalendar.prototype.import = function (text) {

   if (imported.received != null) {
      //console.log("Received additional iCalendar data:\n" + text + "\n");
      text = imported.received + text;
   }

   if (text.search(/END:VCALENDAR/) < 0) {
      //console.log("Received incomplete iCalendar data:\n" + text + "\n");
      imported.received = text;
      return false; // Waiting for the end of the calendar data.
   }
   imported.received = null; // We do not need this buffer anymore.

   var pending = imported.calendar[imported.pending];
   var events = decodeEventsFromICalendar(text);

   // Disable all existing programs for that calendar, now that
   // the new calendar events are available.

   for (var i = 0; i < imported.programs.length; i++) {
      if (imported.programs[i].parent == pending.name) {
         imported.programs[i].active = false;
      }
   }

   for (var i = 0; i < events.length; i++) {

      // Ignore all-day events and events for other controllers
      if (!events[i].hasStart) continue;
      if (events[i].location != imported.location) continue;

      var program = iCalendarToProgram (pending.name, events[i]);
      if (program != null) {
         var is_new_program = true;
         for (var j = 0; j < imported.programs.length; j++) {
            if (imported.programs[j].name == program.name) {
               imported.programs[j] = program;
               is_new_program = false;
               break;
            }
         }
         if (is_new_program) {
            imported.programs[imported.programs.length] = program;
         }
      }
   }

   // Some programs may remain from deleted events: clean them up.

   for (var i = 0; i < imported.programs.length; i++) {
      if (imported.programs[i].parent == pending.name) {
         if (! imported.programs[i].active) {
            imported.programs[i] = new Object();
            imported.programs[i].active = false;
         }
      }
   }
   pending.status = 'ok';
   return true;
}

// --------------------------------------------------------------------------
// Remove calendars that are no longer listed in the DB.
//
function cleanObsoleteCalendars() {

   var present = new Array();

   for (var i = 0; i < imported.calendar.length; i++) {
      present[imported.calendar[i].name] = 1;
   }

   for (var i = 0; i < imported.programs.length; i++) {
      if (present[imported.programs[i].parent] == null) {
         imported.programs[i] = new Object();
         imported.programs[i].active = false;
      }
   }
}

// --------------------------------------------------------------------------
// Cancel the load of a calendar due to network error.
//
function cancelCalendarLoad (e) {

   imported.received = null; // Forget all data in transit.
   imported.calendar[imported.pending].status = 'failed';
   console.error(imported.calendar[imported.pending].name + ': ' + e.message);
   imported.pending = null;
}

// --------------------------------------------------------------------------
// Initiate the GET request for the first 'idle' calendar.
//
// This is a recursive function that calls itself when processing is
// complete for the current (pending) calendar.
//
// The status of a calendar is changed as soon as the GET request has
// been initiated. This status will no be put back to 'idle'.
// As a consequence, this function will scan through the whole list
// of calendars, one by one.
//
// We process all calendar accesses sequentially because of an apparent
// limitation of the http/https framework: seems to be no way to identify
// the request context when processing the response (http.IncomingMessage).
// So there is no choice but to keep a reference to the current calendar
// as a global, i.e. process only one calendar at a time.
//
function loadNextCalendar () {

   for (var i = 0; i < imported.calendar.length; i++) {

      if (imported.calendar[i].status == 'pending') return; // Too early.
      if (imported.calendar[i].status != 'idle') continue;

      var pending = imported.calendar[i];

      console.log("Importing calendar: " + pending.name);
      imported.pending = i;
      pending.status = 'pending';

      if (pending.source.match ("https://.*")) {

         https.get(pending.source, function(res) {
            res.on('data', function(d) {
               if (imported.pending == null) return;
               if (imported.calendar[imported.pending].import(d.toString())) {
                  loadNextCalendar();
               }
            });
   
         }).on('error', function(e) {
            cancelCalendarLoad (e);
            loadNextCalendar();
         });
         return;
      }

      if (pending.source.match ("http://.*")) {

         http.get(pending.source, function(res) {
            res.on('data', function(d) {
               if (imported.pending == null) return;
               if (imported.calendar[imported.pending].import(d.toString())) {
                  loadNextCalendar();
               }
            });
   
         }).on('error', function(e) {
            cancelCalendarLoad (e);
            loadNextCalendar();
         });
         return;
      }

      // The calendar source URL does not match any supported protocol.

      console.error (pending.name +
                     ": unsupported protocol in '" + pending.source + "'");
      pending.status = 'error';
   }

   // We are done processing all calendars.
   imported.pending = null;
   cleanObsoleteCalendars();
   // console.log("Import complete: " + JSON.stringify(imported));
}

exports.refresh = loadNextCalendar;

exports.programs = function () {
   var active_programs = new Array();
   for (var i = 0; i < imported.programs.length; i++) {
      if (imported.programs[i].active) {
         active_programs[active_programs.length] = imported.programs[i];
      }
   }
   return active_programs;
}

