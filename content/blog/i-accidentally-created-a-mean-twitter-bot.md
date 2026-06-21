---
title: "I accidentally created a mean Twitter bot"
date: 2016-04-23
path: /blog/2016/4/23/i-accidentally-created-a-mean-twitter-bot
slug: i-accidentally-created-a-mean-twitter-bot
tags: ["Bots", "Software", "Twitter"]
description: "What happened when I trained a Markov-chain Twitter bot on my own posting history."
---
I've been pretty fascinated with Twitter bots lately. I recently wrote [@random\_map](https://twitter.com/random_map), a bot that tweets random aerial images of the Earth every hour, but I've always wanted to create a Markov Chain based bot that would create random tweets based on words and phrases I would use.

For those who aren't familiar with Markov Chaining, it's a random process that uses probability and states to decide where to go next. One important property of a Markov Chain is that past transitions don't affect future transitions. In the sense of @CailinBot, Markov Chaining is used to decide the next phrase/word to use in a tweet, after choosing the current word/phrase to use.

For example, here is a simple Markov Chain with two states:

<figure><img src="/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp" alt=" State A has a 20% chance of looping, and an 80% chance of transitioning to State B. State B has a 50% chance of transitioning to State A, and a 50% chance of looping. "><figcaption>State A has a 20% chance of looping, and an 80% chance of transitioning to State B. State B has a 50% chance of transitioning to State A, and a 50% chance of looping.</figcaption></figure>

Yesterday, I was itching to finally tackle this, so I sat down and wrote [@CailinBot](https://twitter.com/cailinbot), using a really cool Ruby gem called [twitter\_ebooks](https://github.com/mispy/twitter_ebooks). This gem fetched the past 4000 tweets from my personal Twitter account, saved popular words and phrases as a text model, and used Markov Chaining to create @CailinBot tweets. Once I finished setting up the bot and assigning actions (how to respond to private messages, when to reply to someone when someone mentions it, etc.), I set it up on my Raspberry Pi and let it go to work.

I quickly realized I had created a monster.

It immediately started being snarky:

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

It doesn't like USG very much:

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

It's obsessed with fungus:

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp) ![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

It pays attention to national politics:

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp) ![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp) ![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

It can be mean at times:

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp) ![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp) ![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

It also has emotions:

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

Oh, and apparently it thinks it is a human being?

![](/images/i-accidentally-created-a-mean-twitter-bot/image-asset.webp)

Very odd.
