// Generated by CoffeeScript 1.3.3
(function() {

  define(['data-frame/widgets/text', 'data-frame/widgets/textArea', 'data-frame/widgets/foreignKey', 'data-frame/widgets/integer', 'data-frame/widgets/boolean', 'data-frame/widgets/real'], function(text, textArea, foreignKey, integer, boolean, real) {
    var widgets;
    widgets = {};
    widgets['Value'] = text;
    widgets['Short Text'] = text;
    widgets['Long Text'] = textArea;
    widgets['ConceptType'] = foreignKey;
    widgets['ForeignKey'] = foreignKey;
    widgets['Integer'] = integer;
    widgets['Boolean'] = boolean;
    widgets['Real'] = real;
    widgets['Serial'] = function(action, id, value) {
      if (value !== '') {
        return value;
      }
      return '?';
    };
    widgets['JSON'] = widgets['Interval'] = widgets['Date'] = widgets['Date Time'] = widgets['Time'] = function() {
      return 'TODO';
    };
    return function(widgetType, action, id, value, foreignKeys) {
      if (foreignKeys == null) {
        foreignKeys = [];
      }
      if (widgets.hasOwnProperty(widgetType)) {
        return widgets[widgetType](action, id, value, foreignKeys);
      } else {
        return console.error('Hit default, wtf?', widgetType);
      }
    };
  });

}).call(this);
