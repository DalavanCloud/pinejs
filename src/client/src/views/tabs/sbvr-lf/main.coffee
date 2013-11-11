define [
	'backbone'
	'cs!./lfviz'
	'css!./style'
], (Backbone, lfviz) ->
	Backbone.View.extend(
		setTitle: (title) ->
			@options.title.text(title)

		render: ->
			@setTitle('Logical Formulation')

			rerenderRequired = true
			@options.title.on 'shown', =>
				if rerenderRequired == false
					return
				rerenderRequired = false
				try
					lfviz(@model.compile(), @el)
				catch e
					console.log(e)

			@model.on 'change:content', =>
				rerenderRequired = true
	)
