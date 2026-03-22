function updateFromHerokDataSource()
{
  var utility = new WildernessAppScriptLibrary.Utility();  
  if(utility.isInWorkingHours(7,19))
  {
    var sheetName=SpreadsheetApp.getActiveSpreadsheet().getName();     
    populateSheet("Live - Bookings",WildernessAppScriptLibrary.getSharedDataclipUrl("rtsvjpzqklpiqphnhelhxwnbgakr",sheetName),0,0);
    populateSheet("Live - Unfinished - Last 24 Months",WildernessAppScriptLibrary.getSharedDataclipUrl("fckrgutyhvrgcqyecrvuemyzcvon",sheetName),0,0);
    populateSheet("Live - Booking Payments",WildernessAppScriptLibrary.getSharedDataclipUrl("xkgimixvartntefflcqyqigkmtil",sheetName),0,0);
    
  }
}


function test() {
  // TODO: add test logic
}

function testReturnString() {
  return "test passed";
}


function populateSheet(sheetName,url, startCol, endCol) {
  
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); 
  var responseCode = response.getResponseCode()
  var responseBody = response.getContentText()  
  var data = JSON.parse(response.getContentText());
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName); 

  if (responseCode == 200) {
    if(data.values.length >0)
    {  
      data.values.unshift(data.fields); // merge headers into array    
    
      if(startCol==0)
      {
        sheet.getRange(1, 1, sheet.getMaxRows(), data.fields.length).clearContent(); 
        sheet.getRange(1, 1,data.values.length, data.fields.length).setValues(data.values);
      }
      else
      {  
        var numCols = endCol-startCol + 1;
        sheet.getRange(1,startCol,sheet.getMaxRows(),numCols).clearContent();     
        sheet.getRange(1,startCol,data.values.length,numCols).setValues(data.values);
      } 
    
    }
    else
    {
      if(startCol==0)
      {
        sheet.getRange(2, 1, sheet.getMaxRows(), data.fields.length).clearContent();   
      }
      else
      {  
        var numCols = endCol-startCol + 1;
        sheet.getRange(2,startCol,sheet.getMaxRows(),numCols).clearContent();         
      }
    }
  }
  else{
    Logger.log(Utilities.formatString("Request failed. Expected 200, got %d: %s", responseCode, responseBody))
  }
  
}