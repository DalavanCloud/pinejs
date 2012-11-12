define([
	'backbone'
	'jquery'
	'underscore'
	'codemirror'
	'codemirror-ometa-bridge/hinter'
	'codemirror-ometa-bridge/sbvr'
	'codemirror-simple-hint'
], (Backbone, $, _, CodeMirror, ometaAutoComplete) ->
	Backbone.View.extend(
		setTitle: (title) ->
			@options.title.text(title)

		render: ->
			this.setTitle('Edit')

			textarea = $('<textarea />')
			@$el.empty().append(textarea)
			
			changeHandler = =>
				sbvrEditor.setValue(@model.get('content'))

			updateModel = _.debounce(=>
				@model.off('change:content', changeHandler)
				@model.set('content', sbvrEditor.getValue())
				@model.on('change:content', changeHandler)
			, 500)

			@model.on('change:content', changeHandler)

			sbvrEditor = CodeMirror.fromTextArea(textarea.get(0),
				mode:
					name: 'sbvr'
					getOMetaEditor: -> sbvrEditor
				onKeyEvent: =>
					updateModel()
					ometaAutoComplete.apply(this, arguments)
				lineWrapping: true
			)

			$(window).resize(=>
				sbvrEditor.setSize(@$el.width(), @$el.height())
			).resize()

			sbvrEditor.focus()
	)
)