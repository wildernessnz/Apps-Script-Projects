function getOnRoadGuests()
{  
  //updateFromHerokDataSource(); 
}

function updateFromHerokDataSource()
{
  //var sheetName=SpreadsheetApp.getActiveSpreadsheet().getName();  
  //populateSheet("Raw - OnRoad Bookings",WildernessAppScriptLibrary.getSharedDataclipUrl("dcziibkbltmoagduzzhyscafdbtm",sheetName),0,0);
  
}

function populateSheet(sheetName,url, startCol, endCol) {
  
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });   
  var data = JSON.parse(response.getContentText());
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName); 


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
